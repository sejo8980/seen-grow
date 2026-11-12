import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { buildInsightReport, DEMO } from './lib/report-engine.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STORE_FILE = join(ROOT, 'data', 'store.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_STORED_REPORTS = 400;
const PORT = Number(process.env.PORT || 3000);
const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const PSI_KEY = process.env.PAGESPEED_API_KEY || '';
const hasNaver = Boolean(NAVER_ID && NAVER_SECRET);
const rate = new Map();

const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
const clean = (s, n=180) => String(s ?? '').trim().slice(0,n);
export function stripMarkup(s) { return clean(s, 600).replace(/<[^>]*>/g,'').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/g,"'"); }
export function publicHttpsUrl(str) {
  if (!str) return null;
  try {
    const u = new URL(str);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname.length > 253) return null;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return null;
    if (/^\d+(?:\.\d+){3}$/.test(h) || h.includes(':') || h === '[::1]') return null;
    return u.toString();
  } catch { return null; }
}
async function requestJson(url, options={}) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(14000), redirect: 'error' });
  if (!r.ok) throw new Error(`External API returned HTTP ${r.status}`);
  return r.json();
}
async function naverSearch(kind, query, display=10) {
  if (!hasNaver) throw new Error('NAVER_API_NOT_CONFIGURED');
  const qs = new URLSearchParams({query:clean(query), display:String(display)});
  return requestJson(`https://openapi.naver.com/v1/search/${kind}.json?${qs}`, {
    headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET }
  });
}
async function googlePlaces(query) {
  if (!PLACES_KEY) throw new Error('GOOGLE_PLACES_NOT_CONFIGURED');
  const json = await requestJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {'Content-Type':'application/json', 'X-Goog-Api-Key':PLACES_KEY, 'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.primaryTypeDisplayName,places.websiteUri,places.location'},
    body: JSON.stringify({textQuery:clean(query),languageCode:'ko',regionCode:'KR',pageSize:8})
  });
  return (json.places || []).map(p=>({id:p.id, name:p.displayName?.text||'',address:p.formattedAddress||'',category:p.primaryTypeDisplayName?.text||'',website:p.websiteUri||'',lat:p.location?.latitude??null,lng:p.location?.longitude??null,provider:'Google Places'}));
}
async function searchBusinesses(query, area) {
  const q = [query, area].filter(Boolean).join(' ');
  if(!hasNaver&&!PLACES_KEY)throw new Error('SEARCH_API_NOT_CONFIGURED');
  const tasks=[];
  if(hasNaver)tasks.push(naverSearch('local',q,5).then(data=>(data.items||[]).map((p,i)=>({id:`naver-${i}`,name:stripMarkup(p.title),address:p.roadAddress||p.address||'',category:p.category||'',website:publicHttpsUrl(p.link)||'',provider:'NAVER Local'}))));
  if(PLACES_KEY)tasks.push(googlePlaces(q));
  const results=await Promise.allSettled(tasks);
  const items=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  if(!items.length&&results.some(r=>r.status==='rejected'))throw new Error('SEARCH_UPSTREAM_UNAVAILABLE');
  return items;
}
async function searchFootprint(name) {
  if (!hasNaver) return {status:'not_connected'};
  try {
    const [blog,web,cafe] = await Promise.all([naverSearch('blog',name,100), naverSearch('webkr',name,10),naverSearch('cafearticle',name,10)]);
    return {status:'available',query:name,
      blog:{reportedTotal:blog.total, samples:(blog.items||[]).slice(0,100).map(x=>({title:stripMarkup(x.title),url:x.link,postdate:x.postdate||null})), sampledCount:(blog.items||[]).length},
      cafe:{reportedTotal:cafe.total,samples:(cafe.items||[]).slice(0,4).map(x=>({title:stripMarkup(x.title),url:x.link}))},
      web:{reportedTotal:web.total,samples:(web.items||[]).slice(0,4).map(x=>({title:stripMarkup(x.title),url:x.link}))}};
  } catch(e) {return {status:'error',message:clean(e.message)};}
}
async function checkPageSpeed(url) {
  if (!url) return {status:'not_provided'};
  const valid = publicHttpsUrl(url);
  if (!valid) return {status:'invalid_url'};
  try {
    const qs = new URLSearchParams({url: valid,strategy:'mobile'});
    qs.append('category','PERFORMANCE'); qs.append('category','SEO');
    if (PSI_KEY) qs.append('key',PSI_KEY);
    const data = await requestJson(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`);
    const c = data.lighthouseResult?.categories||{};
    return {status:'available',url:valid,performance:typeof c.performance?.score==='number'?Math.round(c.performance.score*100):null,seo:typeof c.seo?.score==='number'?Math.round(c.seo.score*100):null, source:'Google PageSpeed Insights / Lighthouse', measuredAt:data.analysisUTCTimestamp||new Date().toISOString()};
  } catch(e) {return {status:'error',message:clean(e.message)};}
}
export function makeRecommendations({name,footprint,competitorFootprint,pagespeed,website}) {
  const out=[];
  if(!website) out.push({priority:'우선',title:'공식 웹사이트 정보 확인',reason:'공식 웹사이트 주소가 입력되지 않아 웹페이지 기술 진단을 진행할 수 없어요.',action:'실제 운영 중인 사이트가 있다면 주소를 연결하세요.',product:'종합마케팅솔루션'});
  if(footprint.status==='available') {
    if(footprint.blog.reportedTotal===0) out.push({priority:'우선',title:'상호 검색 콘텐츠 확인',reason:`네이버 블로그 검색 API에서 '${name}' 질의 결과가 0건으로 반환됐어요. 동명이인·검색 표기 차이를 추가 확인해야 해요.`,action:'상호 표기와 콘텐츠 채널을 검토하고 원고 주제를 기획하세요.',product:'바이럴'});
    else out.push({priority:'검토',title:'검색 콘텐츠 관련성 점검',reason:'검색 결과 건수는 확인됐지만 관련성·최신성·실제 고객 유입은 건수만으로 판단할 수 없어요.',action:'상위 검색 결과의 관련성과 콘텐츠 품질을 전문가가 검토하세요.',product:'바이럴'});
  } else out.push({priority:'연동',title:'네이버 공개 검색 데이터 연결',reason:'네이버 API가 미연동 또는 오류 상태라 콘텐츠 검색 규모를 확인하지 못했어요.',action:'관리자가 네이버 검색 API 인증을 설정하세요.',product:null});
  if(competitorFootprint?.status==='available'&&footprint.status==='available') out.push({priority:'검토',title:'경쟁사 비교의 맥락 검증',reason:'두 상호의 검색 결과 건수는 브랜드 고유성, 규모, 업종 차이 영향을 받으므로 점유율이나 인지도 비교로 해석하면 안 돼요.',action:'동일 지역·업종·기간의 비교 기준과 실제 경쟁 관계를 검수하세요.',product:'종합마케팅솔루션'});
  if(pagespeed.status==='available'&&typeof pagespeed.seo==='number'&&pagespeed.seo<80) out.push({priority:'우선',title:'홈페이지 기술 SEO 점검',reason:`PageSpeed Insights의 모바일 Lighthouse SEO 점수가 ${pagespeed.seo}/100으로 확인됐어요.`,action:'Lighthouse 상세 개선 항목을 검토하고 사이트 품질을 개선하세요.',product:'종합마케팅솔루션'});
  if(pagespeed.status==='error') out.push({priority:'추가확인',title:'사이트 진단 재시도',reason:'외부 PageSpeed API로부터 분석 결과를 받지 못했어요.',action:'사이트 URL과 API 할당량을 확인 후 다시 점검하세요.',product:null});
  out.push({priority:'연동',title:'실제 트래픽 분석',reason:'상호 검색만으로 사이트 방문자 수를 알 수 없어요.',action:'사업자 동의 후 GA4와 Search Console을 연동하세요.',product:'종합마케팅솔루션'});
  return out;
}
async function openAiAnalysis(report) {
  if (!OPENAI_KEY) return {status:'not_connected',text:null};
  try {
    const scope={target:report.target,metrics:report.metrics,rank:report.rank,pagespeed:report.pagespeed,recommendations:report.recommendations};
    const j=await requestJson('https://api.openai.com/v1/responses',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`},
      body:JSON.stringify({model:OPENAI_MODEL,max_output_tokens:650,instructions:'당신은 SEEN GROW 마케팅 1차 진단 AI다. 제공한 JSON 이외의 사실을 만들지 마라. 결과 건수를 인지도, 방문자, 시장점유율 또는 실제 순위라고 표현하지 마라. 상호명 중복·경쟁사 비교 편향·데이터 미연동을 반드시 알린다. 이 진단은 반드시 휴먼마케터 검수가 필요한 초안이다. 한국어 친근한 존댓말로 5문장 이내 진단과 실행 우선순위 2개를 작성하라. 측정 기간이 없는 수치에 기간을 지어내지 마라.',input:JSON.stringify(scope)})
    });
    const str=(j.output||[]).flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n').trim();
    return str?{status:'draft_unreviewed',text:str}:{status:'error',text:null};
  }catch(e){return {status:'error',message:clean(e.message),text:null};}
}

// A result position in one *sampled API query* — never an official market-wide rank.
export function rankInSample(items, target) {
  const canonical = value => stripMarkup(value||'').replace(/\s+/g,'').toLocaleLowerCase('ko');
  const matched = items.map((item, idx)=>({item,idx})).filter(({item}) =>
    target.id ? item.id === target.id : (canonical(item.name) === canonical(target.name) &&
      (!target.address || canonical(item.address) === canonical(target.address)))
  );
  if(matched.length > 1) return {status:'ambiguous',position:null};
  if(matched.length === 0) return {status:'not_in_sample',position:null};
  return {status:'found', position:matched[0].idx+1};
}

const GOOGLE_TYPES = {'카페':'cafe','음식점':'restaurant','식당':'restaurant','미용실':'hair_salon','헬스장':'gym','치과':'dentist','네일샵':'beauty_salon','꽃집':'florist'};
async function localRank(input) {
  const provider = clean(input.provider,20)||'naver';
  const name=clean(input.name,80), area=clean(input.area,80), category=clean(input.category,60);
  if(!name||!area||!category) throw new Error('상호, 지역, 업종은 필수입니다.');
  let items, query, source, limit, method;
  if(provider==='naver') {
    if(!hasNaver) throw new Error('네이버 API 연동이 필요합니다.');
    query=`${area} ${category}`;
    const data=await naverSearch('local',query,5);
    items=(data.items||[]).map(p=>({name:stripMarkup(p.title),address:p.roadAddress||p.address||'',category:p.category||''}));
    source='NAVER Search Local API'; limit=5;method='네이버 지역 검색 API 정확도순 표본 위치';
  } else if(provider==='google') {
    if(!PLACES_KEY) throw new Error('Google Places API 연동이 필요합니다.');
    if(!input.googlePlaceId) throw new Error('먼저 Google Places에서 상호를 찾아 선택해야 합니다.');
    const type=GOOGLE_TYPES[category];
    if(!type) throw new Error('이 업종은 아직 Google 주변 검색 분류를 지원하지 않습니다.');
    const lat=Number(input.lat),lng=Number(input.lng),radius=Math.min(5000,Math.max(300,Number(input.radius)||1500));
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) throw new Error('장소 좌표를 확인해야 합니다.');
    const data=await requestJson('https://places.googleapis.com/v1/places:searchNearby',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':PLACES_KEY,'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.userRatingCount,places.rating'},body:JSON.stringify({includedTypes:[type],maxResultCount:20,rankPreference:'POPULARITY',languageCode:'ko',locationRestriction:{circle:{center:{latitude:lat,longitude:lng},radius}}})});
    items=(data.places||[]).map(p=>({id:p.id,name:p.displayName?.text||'',address:p.formattedAddress||'',googleReviewCount:typeof p.userRatingCount==='number'?p.userRatingCount:null,googleRating:typeof p.rating==='number'?p.rating:null}));
    query=`${type} / 반경 ${radius}m`;source='Google Places Nearby Search';limit=20;method='Google Places API 인기도순 표본 위치';
  }else throw new Error('지원하지 않는 순위 출처입니다.');
  const rank=rankInSample(items,{id:provider==='google'?clean(input.googlePlaceId):undefined,name,address:clean(input.address)});
  return {provider,query,source,method,area,category,target:name,position:rank.position,status:rank.status,sampleSize:items.length,sampleLimit:limit,results:items,measuredAt:new Date().toISOString(),disclaimer:'공식 시장점유율·동네 전체 순위·네이버 지도 실제 검색순위가 아닙니다. 특정 조건의 API 표본 위치입니다. 표본에 없다고 순위 밖이나 하위권이라고 단정하지 않습니다.'};
}

async function diagnose(input) {
  const target={name:clean(input.name,80),area:clean(input.area,80),category:clean(input.category,120),website:publicHttpsUrl(input.website)||null};
  if (!target.name) throw new Error('상호명이 필요합니다.');
  const competitorName=clean(input.competitorName,80);
  const [footprint,comp,pagespeed]=await Promise.all([
    searchFootprint(target.name),
    competitorName?searchFootprint(competitorName):Promise.resolve(null),
    checkPageSpeed(target.website)
  ]);
  const report={target,footprint,competitor:competitorName||null,competitorFootprint:comp,pagespeed,
    traffic:{status:'requires_owner_permission',visits:null,source:'GA4 연결 후 측정 가능'},
    awareness:{status:'not_measured',value:null,reason:'검색 건수와 인지도를 동일시하지 않음'},
    generatedAt:new Date().toISOString(),humanReview:{status:'pending',required:true}};
  report.recommendations=makeRecommendations({...report,name:target.name,website:target.website});
  report.ai=await openAiAnalysis(report);
  return report;
}

// v2: Strictly differentiated metrics; unknown is null, not zero.
const CATALOG = Object.freeze([
 {id:'viral-1',category:'바이럴',name:'바이럴 원고 체험',priceKRW:9900,unit:'원고 1건',deliverables:['AI 초안','인간 마케터 기본 검수 1회'],excludes:['채널 업로드','상위 노출 보장'],status:'proposed',note:'글 길이, 수정 범위, 배송기한, VAT 표시 확정 전'},
 {id:'ad-setup',category:'매체광고셋팅',name:'검색광고 세팅 체험',priceKRW:50000,unit:'매체 1회',deliverables:['1개 매체의 1개 캠페인 기본 세팅','세팅 내용 체크리스트'],excludes:['광고 집행비','광고 성과 보장','지속 운영'],status:'proposed',note:'계정 권한 및 광고 매체, VAT 표시 확정 전'},
 {id:'blog-trial',category:'바이럴',name:'블로그 체험단 운영 체험',priceKRW:10000,unit:'모집 관리 1인',deliverables:['참여자 모집/관리 업무'],excludes:['체험 제품·서비스 비용','원고 대필','무조건적인 후기 게시 보장'],status:'proposed',note:'참여자의 실제 경험과 경제적 이해관계 표시 필수. 참여자 모집비/제공 혜택 및 VAT 확정 전'},
]);

function latest30DaysStart(now=new Date()) {const x=new Date(now);x.setUTCDate(x.getUTCDate()-29);return x.toISOString().slice(0,10);}
export function countSampleRecentBlogPosts(samples=[],now=new Date()) {
 const from=latest30DaysStart(now).replaceAll('-','');
 const through=now.toISOString().slice(0,10).replaceAll('-','');
 const valid=samples.filter(x=>/^\d{8}$/.test(String(x.postdate||'')));
 return {inReturnedSample:valid.filter(x=>x.postdate>=from&&x.postdate<=through).length,datedSampleSize:valid.length,totalSamples:samples.length,
  reliableForFullVolume:false,label:'반환된 블로그 검색 표본 중 최근 30일 게시일이 확인된 수',warning:'검색 API는 전체 게시물을 완전하게 반환하지 않아 실제 30일 발행량 또는 체험단 운영 수가 아닙니다.'};
}
async function naverTrend30d(name) {
 if(!hasNaver)return {status:'not_connected',series:[]};
 const today=new Date();const from=new Date(today);from.setUTCDate(from.getUTCDate()-29);
 try {
  const j=await requestJson('https://openapi.naver.com/v1/datalab/search',{method:'POST',headers:{'Content-Type':'application/json','X-Naver-Client-Id':NAVER_ID,'X-Naver-Client-Secret':NAVER_SECRET},body:JSON.stringify({startDate:from.toISOString().slice(0,10),endDate:today.toISOString().slice(0,10),timeUnit:'week',keywordGroups:[{groupName:name,keywords:[name]}]})});
  return {status:'available',source:'NAVER Datalab relative search trend',unit:'상대 검색 관심도 (0~100), 절대 검색량 아님',series:(j.results?.[0]?.data||[]).map(x=>({period:x.period,ratio:x.ratio}))};
 }catch(e){return {status:'error',message:clean(e.message),series:[]};}
}
async function googleReviewSummary(placeId){
 if(!placeId)return {status:'not_selected',reviewCount:null,rating:null};
 if(!PLACES_KEY)return {status:'not_connected',reviewCount:null,rating:null};
 // Only provider-issued IDs previously selected by the customer are accepted.
 const id=clean(placeId,200);
 if(!/^[\w-]{4,200}$/.test(id))return {status:'invalid_id',reviewCount:null,rating:null};
 try{
  const j=await requestJson('https://places.googleapis.com/v1/places/'+encodeURIComponent(id),{headers:{'X-Goog-Api-Key':PLACES_KEY,'X-Goog-FieldMask':'id,displayName,userRatingCount,rating'}});
  return {status:'available',reviewCount:typeof j.userRatingCount==='number'?j.userRatingCount:null,rating:typeof j.rating==='number'?j.rating:null,source:'Google Places, 측정 당시 누적치',measuredAt:new Date().toISOString()};
 }catch(e){return {status:'error',message:clean(e.message),reviewCount:null,rating:null};}
}
export function composeMarketingReport({name,footprint,trend,googleReviews,now=new Date()}){
 const recentBlog=footprint.status==='available'?countSampleRecentBlogPosts(footprint.blog.samples,now):null;
 const metrics=[
  {id:'blog-search',name:'블로그 관련 검색 결과',value:footprint.status==='available'?footprint.blog.reportedTotal:null,unit:'검색 결과 건',status:footprint.status==='available'?'observed':'unavailable',period:'검색 시점의 결과 총량(30일 수 아님)',source:'NAVER Blog Search API',warning:'상호와 무관한 동명이인·중복·검색 색인 변화 가능'},
  {id:'blog-30d',name:'최근 30일 블로그 게시물 표본',value:recentBlog?.inReturnedSample??null,unit:'표본 건',status:recentBlog?'sample':'unavailable',period:'최근 30일',source:'NAVER Blog Search API',warning:recentBlog?.warning||'데이터 없음'},
  {id:'cafe-search',name:'카페 관련 검색 결과',value:footprint.status==='available'?footprint.cafe?.reportedTotal??null:null,unit:'검색 결과 건',status:footprint.status==='available'?'observed':'unavailable',period:'검색 시점 총량(월별 수 아님)',source:'NAVER Cafearticle Search API',warning:'실제 월별 발행량이나 캠페인 실행 건수가 아님'},
  {id:'google-review',name:'구글 누적 리뷰',value:googleReviews.reviewCount,unit:'건',status:googleReviews.status==='available'?'observed':'unavailable',period:'현재 누적',source:'Google Places API',warning:'30일 신규 리뷰 수는 과거 스냅샷 없이는 알 수 없음'},
  {id:'naver-review',name:'네이버 방문자 리뷰',value:null,unit:'건',status:'owner_data_required',period:'확인 불가',source:'네이버 스마트플레이스 사업주 통계 등',warning:'공개 검색 API만으로 정확한 리뷰 수의 기간별 집계를 보장할 수 없음'},
  {id:'keyword-trend',name:'브랜드 검색 관심도',value:trend.status==='available'?trend.series:null,unit:'상대지수',status:trend.status==='available'?'observed':'unavailable',period:'최근 30일',source:'NAVER DataLab API',warning:'절대 검색어 트래픽 또는 검색 횟수가 아님'},
  {id:'place-visits',name:'플레이스 상세 유입',value:null,unit:'회',status:'owner_data_required',period:'최근 30일',source:'스마트플레이스 사업주 통계',warning:'사업주 제공 데이터 필요'},
  {id:'place-saves',name:'플레이스 저장·찜',value:null,unit:'건',status:'not_publicly_verified',period:'확인 불가',source:'이용 가능한 사업주 자료 확인 필요',warning:'공개 API에서 전체 누적/월간 값을 제공한다고 확인되지 않음'},
  {id:'campaign-blog',name:'실제 운영한 체험단',value:null,unit:'명',status:'campaign_log_required',period:'최근 30일',source:'광고주·대행사 캠페인 운영 기록',warning:'검색 게시물에 협찬 표시가 있어도 해당 매장 캠페인 운영 건수로 단정 불가'},
  {id:'ai-citations',name:'AI 검색 출처 인용',value:null,unit:'회',status:'test_required',period:'테스트 필요',source:'서비스별 지정 질의·날짜·출처 기록',warning:'공식 통합 순위 없음. 수동/허용된 테스트 방법 설계 필요'},
 ];
 const available=metrics.filter(m=>m.status==='observed'||m.status==='sample').length;
 return {name,requestedPeriod:'최근 30일 무료 진단',dataAvailability:{collectedMetrics:available,totalMetrics:metrics.length},metrics,
  actions:[
   {priority:'1',name:'업체 식별·검색 존재감 확인',reason:'동명이인과 검색 결과 관련성을 검수한 후 전략을 정해야 해요.',suggestedProduct:null},
   {priority:'2',name:'트래픽·리뷰의 실제 추세 확인',reason:'실제 유입, 리뷰 증가, 저장/찜 추이는 소유자 자료 또는 누적 측정 기록이 필요해요.',suggestedProduct:null},
   {priority:'3',name:'필요하면 소액 상품부터 시범 운영',reason:'문제 확인 후 바이럴/광고 세팅 중 적합한 하나만 시범 운영하고 결과를 비교해요.',suggestedProduct:'viral-1'}],
  caveat:'이 보고서는 공개 자료 기반의 미검수 AI 진단 참고 자료이며 시장점유율이나 동네 전체 순위, 실제 매출을 계산하지 않습니다.',humanReview:{status:'not_requested',note:'12년 경력 전문가의 실제 검수는 별도 업무 단계이며 현재 자동화되어 있지 않습니다.'}};
}

async function marketingReport(input){
 if(input.period==='12m')return {error:'회원 기능 미구현: 실제 회원 인증과 원본 데이터 접근 권한을 연동한 뒤 제공해야 합니다.',code:'AUTH_REQUIRED'};
 const name=clean(input.name,80);
 if(!name)throw new Error('상호명이 필요합니다.');
 const [footprint,trend,reviews] = await Promise.all([searchFootprint(name),naverTrend30d(name),googleReviewSummary(input.googlePlaceId)]);
 return composeMarketingReport({name,footprint,trend,googleReviews:reviews});
}


const routes={'/':'index.html','/styles.css':'styles.css','/app.js':'app.js','/admin':'admin.html','/admin.js':'admin.js'};
const memory={users:[],sessions:[],reports:[],orders:[],meetings:[],coupons:[]};
let writeChain=Promise.resolve();
let storeInitialized=false;
async function store(){
 if(!storeInitialized){
  try{const existing=JSON.parse(await readFile(STORE_FILE,'utf8'));for(const key of Object.keys(memory))if(Array.isArray(existing[key]))memory[key]=existing[key];}catch(e){if(e.code!=='ENOENT')console.error('DB load failure', e.message);}
  storeInitialized=true;
 }
 return memory;
}
function persist(){
 writeChain=writeChain.then(async()=>{await mkdir(join(ROOT,'data'),{recursive:true});await writeFile(STORE_FILE+'.tmp',JSON.stringify(memory,null,2),{mode:0o600});const {rename}=await import('node:fs/promises');await rename(STORE_FILE+'.tmp',STORE_FILE);});
 return writeChain;
}
const sha=x=>createHash('sha256').update(x).digest('hex');
function passwordHash(pass,salt){return scryptSync(pass,salt,64).toString('hex');}
function cookie(req,name){return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';}
async function getUser(req){const db=await store();const token=cookie(req,'seen_session');if(!token)return null;const sess=db.sessions.find(s=>s.hash===sha(token)&&s.expires>Date.now());return sess?db.users.find(u=>u.id===sess.uid)||null:null;}
function sessionCookie(token){return `seen_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.COOKIE_SECURE==='1'?'; Secure':''}`;}
function checkOrigin(req){const origin=req.headers.origin;const host=req.headers.host;return !origin||new URL(origin).host===host;}
function memberPublic(user){return user?{id:user.id,email:user.email,createdAt:user.createdAt}:null;}
function adminAllowed(req){if(!ADMIN_TOKEN)return false;const h=req.headers.authorization||'';const b='Bearer '+ADMIN_TOKEN;return h.length===b.length&&timingSafeEqual(Buffer.from(h),Buffer.from(b));}
async function fullReport(input,user){
 const period=input.period==='12m'?'12m':'30d';if(period==='12m'&&!user) return {error:'12개월 진단은 무료 회원가입 후 이용할 수 있어요.',code:'AUTH_REQUIRED'};
 if(input.demo===true){const demo={...DEMO,requestedPeriod:period,generatedAt:new Date().toISOString()};return {report:demo,insights:buildInsightReport(demo),demo:true,notice:'이 화면의 수치는 실측이 아닌 가상 예시입니다. 실제 업체 진단에 사용할 수 없습니다.'};}
 if(input.acceptPrivacy!==true)return {error:'진단 데이터 저장 안내에 동의해 주세요.',code:'BAD_INPUT'};
 const name=clean(input.name,80),area=clean(input.area,80),category=clean(input.category,60);
 if(!name)return {error:'상호명이 필요합니다.',code:'BAD_INPUT'};
 if(input.website&&!publicHttpsUrl(input.website))return {error:'사이트 주소는 HTTPS URL만 입력해 주세요.',code:'BAD_INPUT'};
 const googlePlaceId=clean(input.googlePlaceId,180);
 let rank=null;
 const jobs=[searchFootprint(name),googleReviewSummary(googlePlaceId),checkPageSpeed(input.website?publicHttpsUrl(input.website):null)];
 let trend;
 if(period==='12m'){
  trend=naverTrendMonths(name,12);
 }else trend=naverTrend30d(name);
 jobs.push(trend);
 const [footprint,googleReviews,pagespeed,trendData]=await Promise.all(jobs);
 if(area&&category&&Boolean(input.includeRank)){
  try{rank=await localRank({provider:input.googlePlaceId&&PLACES_KEY?'google':'naver',name,area,category,address:clean(input.address,150),googlePlaceId,lat:input.lat,lng:input.lng});}catch(e){rank={status:'unavailable',source:'NAVER Local API',reason:clean(e.message)}}
 }
 const raw=composeMarketingReport({name,footprint,trend:trendData,googleReviews});
 raw.metrics=raw.metrics.map(m=>m.id==='keyword-trend'?{...m,period:period==='12m'?'최근 12개월':'최근 30일',value:trendData.status==='available'?trendData.series:null}:m);
 // The 30-day blog sample is the same limited sample for both periods; we never label it 12m count.
 raw.name=name;raw.area=area;raw.category=category;raw.pagespeed=pagespeed;raw.rank=rank;raw.requestedPeriod=period;raw.generatedAt=new Date().toISOString();raw.isDemo=false;
 const insights=buildInsightReport(raw);
 const analysisPayload={target:{name,area,category},metrics:raw.metrics,rank,pagespeed,recommendations:insights.priorities};
 const ai=await openAiAnalysis(analysisPayload);
 const report={report:raw,insights,ai,humanReview:{status:'pending',reviewedAt:null},demo:false,id:randomUUID(),ownerId:user?.id||null};
 const db=await store();db.reports.unshift({...report,createdAt:new Date().toISOString()});db.reports=db.reports.slice(0,MAX_STORED_REPORTS);await persist();
 return report;
}
async function naverTrendMonths(name,count=12){
 if(!hasNaver)return {status:'not_connected',series:[]};
 const now=new Date(); const from=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-count+1,1));
 try{const j=await requestJson('https://openapi.naver.com/v1/datalab/search',{method:'POST',headers:{'Content-Type':'application/json','X-Naver-Client-Id':NAVER_ID,'X-Naver-Client-Secret':NAVER_SECRET},body:JSON.stringify({startDate:from.toISOString().slice(0,10),endDate:now.toISOString().slice(0,10),timeUnit:'month',keywordGroups:[{groupName:name,keywords:[name]}]})});
 return {status:'available',source:'NAVER DataLab relative search trend',unit:'12개월 구간 내 상대지수 0~100. 절대 검색량 아님',series:(j.results?.[0]?.data||[]).map(x=>({period:x.period,ratio:x.ratio}))};
 }catch(e){return {status:'error',message:clean(e.message),series:[]};}
}
function priceItem(id){
 const extras=[
  {id:'all-in-one',category:'종합마케팅솔루션',name:'종합 마케팅 전략 상담',priceKRW:null,unit:'견적 상담',deliverables:['AI 진단 검토','업종별 전략 설계','맞춤 견적'],excludes:['사전 합의 없는 마케팅 실행','성과 보장'],status:'proposed',note:'상담 후 별도 계약'},
  {id:'instagram',category:'인스타대행',name:'인스타그램 운영 상담',priceKRW:null,unit:'견적 상담',deliverables:['현재 계정 진단','월간 콘텐츠 운영안 제안'],excludes:['촬영·디자인·업로드 비용 미포함'],status:'proposed',note:'콘텐츠 수량/촬영 범위 확정 후 견적'}
 ]; return [...CATALOG,...extras].find(x=>x.id===id)||null;
}
function fullCatalog(){return [...CATALOG,priceItem('all-in-one'),priceItem('instagram')];}
function safeText(x,n=150){return clean(x,n).replace(/[<>]/g,'');}

async function readBody(req) {
  let size=0;const chunks=[];
  for await (const chunk of req) {size+=chunk.length;if(size>10000) throw new Error('요청이 너무 큽니다.');chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch {throw new Error('유효한 JSON이 아닙니다.');}
}
const server=http.createServer(async(req,res)=>{
  try {
    const ip=req.socket.remoteAddress||'unknown';const now=Date.now();const r=rate.get(ip)||{until:now+3600000,n:0};
    if(now>r.until){r.until=now+3600000;r.n=0;}r.n++;rate.set(ip,r);
    if(r.n>160)return send(res,429,{error:'요청 횟수 제한에 도달했습니다.'});
    const u=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&routes[u.pathname]){
      const ext=u.pathname.endsWith('.css')?'text/css':u.pathname.endsWith('.js')?'application/javascript':'text/html';
      const b=await readFile(join(ROOT,'public',routes[u.pathname]));
      res.writeHead(200,{'Content-Type':ext+'; charset=utf-8','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'}); return res.end(b);
    }

    if(req.method==='GET'&&u.pathname==='/api/products')return send(res,200,{products:fullCatalog(),disclaimer:'시범 가격 안내. 실제 구매·결제는 PG 연동 이후에 가능합니다.'});
    if(req.method==='GET'&&u.pathname==='/api/me')return send(res,200,{user:memberPublic(await getUser(req))});
    if(req.method==='POST'&&u.pathname==='/api/auth/register'){
      if(!checkOrigin(req))return send(res,403,{error:'요청 출처를 확인할 수 없어요.'});
      const b=await readBody(req);const email=safeText(b.email,150).toLowerCase(),pass=String(b.password||'');
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||pass.length<10||pass.length>120)return send(res,400,{error:'이메일 형식과 10자 이상 비밀번호를 확인해 주세요.'});
      const db=await store();if(db.users.some(x=>x.email===email))return send(res,409,{error:'이미 가입된 이메일입니다.'});
      const salt=randomBytes(16).toString('hex');const user={id:randomUUID(),email,passwordHash:passwordHash(pass,salt),salt,createdAt:new Date().toISOString()};
      db.users.push(user);const token=randomBytes(32).toString('hex');db.sessions.push({uid:user.id,hash:sha(token),expires:Date.now()+604800000});await persist();
      res.setHeader('Set-Cookie',sessionCookie(token));return send(res,201,{user:memberPublic(user)});
    }
    if(req.method==='POST'&&u.pathname==='/api/auth/login'){
      if(!checkOrigin(req))return send(res,403,{error:'요청 출처를 확인할 수 없어요.'});
      const b=await readBody(req);const email=safeText(b.email,150).toLowerCase(),pass=String(b.password||'');
      const db=await store();const user=db.users.find(x=>x.email===email);
      const attempt=passwordHash(pass.slice(0,120),user?.salt||'00000000000000000000000000000000');
      if(!user||!timingSafeEqual(Buffer.from(attempt),Buffer.from(user.passwordHash)))return send(res,401,{error:'이메일 또는 비밀번호를 확인해 주세요.'});
      const token=randomBytes(32).toString('hex');db.sessions.push({uid:user.id,hash:sha(token),expires:Date.now()+604800000});await persist();
      res.setHeader('Set-Cookie',sessionCookie(token));return send(res,200,{user:memberPublic(user)});
    }
    if(req.method==='POST'&&u.pathname==='/api/auth/logout'){
      if(!checkOrigin(req))return send(res,403,{error:'요청 출처를 확인할 수 없어요.'});
      const db=await store();const token=cookie(req,'seen_session');db.sessions=db.sessions.filter(s=>s.hash!==sha(token));await persist();res.setHeader('Set-Cookie','seen_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return send(res,200,{ok:true});
    }
    if(req.method==='POST'&&u.pathname==='/api/full-diagnosis'){
      if(!checkOrigin(req))return send(res,403,{error:'요청 출처를 확인할 수 없어요.'});
      const b=await readBody(req);const result=await fullReport(b,await getUser(req));
      return send(res,result.code==='AUTH_REQUIRED'?401:result.code?400:200,result);
    }
    if(req.method==='GET'&&/^\/api\/reports\/[0-9a-f-]{36}$/i.test(u.pathname)){
      const user=await getUser(req);if(!user)return send(res,401,{error:'로그인이 필요합니다.'});
      const db=await store(),id=u.pathname.split('/').pop(),rep=db.reports.find(x=>x.id===id&&x.ownerId===user.id);
      if(!rep)return send(res,404,{error:'조회 가능한 리포트가 없습니다.'});
      return send(res,200,{...rep});
    }
    if(req.method==='GET'&&u.pathname==='/api/my-reports'){
      const user=await getUser(req);if(!user)return send(res,401,{error:'로그인이 필요합니다.'});
      const db=await store();return send(res,200,{reports:db.reports.filter(x=>x.ownerId===user.id).slice(0,24).map(x=>({id:x.id,name:x.report.name,createdAt:x.createdAt,status:x.humanReview.status,requestedPeriod:x.report.requestedPeriod}))});
    }
    if(req.method==='POST'&&u.pathname==='/api/meeting'){
      if(!checkOrigin(req))return send(res,403,{error:'요청 출처를 확인할 수 없어요.'});
      const b=await readBody(req);const contact=safeText(b.contact,130),name=safeText(b.name,80),details=safeText(b.details,500),date=safeText(b.preferredAt,50);
      if(name.length<2||contact.length<5||details.length<3)return send(res,400,{error:'성함, 연락처, 상담 목적을 작성해 주세요.'});
      if(b.acceptPrivacy!==true)return send(res,400,{error:'개인정보 수집 안내를 확인해 주세요.'});
      const db=await store(),id=randomUUID();db.meetings.unshift({id,name,contact,details,preferredAt:date,reportId:safeText(b.reportId,90),status:'requested',createdAt:new Date().toISOString()});await persist();return send(res,201,{id,status:'requested',message:'상담 요청이 접수되었습니다. 예약 확정이 아니며 담당자 확인이 필요합니다.'});
    }
    if(req.method==='POST'&&u.pathname==='/api/orders'){
      if(!checkOrigin(req))return send(res,403,{error:'요청 출처를 확인할 수 없어요.'});
      const b=await readBody(req);const contact=safeText(b.contact,140),customer=safeText(b.customer,80);
      if(customer.length<2||contact.length<5||b.acceptTerms!==true)return send(res,400,{error:'고객 정보와 주문 요청 동의를 확인해 주세요.'});
      const entries=Array.isArray(b.items)?b.items:[];
      if(entries.length===0||entries.length>12)return send(res,400,{error:'상품을 선택해 주세요.'});
      const items=[];for(const e of entries){const p=priceItem(safeText(e.id,80)),quantity=Number(e.quantity);if(!p||p.priceKRW===null||!Number.isInteger(quantity)||quantity<1||quantity>30)return send(res,400,{error:'주문 가능한 상품과 수량을 확인해 주세요.'});items.push({id:p.id,name:p.name,priceKRW:p.priceKRW,quantity,lineTotal:p.priceKRW*quantity});}
      const db=await store();const code=safeText(b.coupon,40).toUpperCase();const coupon=code?db.coupons.find(x=>x.code===code&&x.status==='active'&&x.expiresAt>Date.now()):null;
      if(code&&!coupon)return send(res,400,{error:'사용 가능한 쿠폰이 아닙니다.'});
      const subtotal=items.reduce((sum,x)=>sum+x.lineTotal,0),discount=coupon?Math.floor(subtotal*coupon.discountPct/100):0;
      const id=randomUUID();db.orders.unshift({id,customer,contact,items,couponCode:coupon?.code||null,subtotal,discount,total:subtotal-discount,status:'payment_not_connected',createdAt:new Date().toISOString()});await persist();
      return send(res,201,{id,total:subtotal-discount,status:'payment_not_connected',message:'구매 요청이 접수되었습니다. 실제 결제는 진행되지 않았습니다. 담당자가 결제 안내를 드릴 예정입니다.'});
    }
    if(u.pathname==='/api/admin/queue'&&req.method==='GET'){
      if(!adminAllowed(req))return send(res,403,{error:'관리자 인증 실패 또는 ADMIN_TOKEN 미설정'});
      const db=await store();return send(res,200,{meetings:db.meetings.slice(0,100),orders:db.orders.slice(0,100),reports:db.reports.slice(0,100).map(x=>({id:x.id,name:x.report.name,createdAt:x.createdAt,status:x.humanReview.status,ai:x.ai?.text||null,sections:x.insights.sections}))});
    }
    if(u.pathname==='/api/admin/review'&&req.method==='POST'){
      if(!checkOrigin(req)||!adminAllowed(req))return send(res,403,{error:'관리자 인증 실패'});
      const b=await readBody(req);const db=await store(),rep=db.reports.find(x=>x.id===b.id);if(!rep)return send(res,404,{error:'리포트를 찾지 못했습니다.'});
      const notes=safeText(b.notes,500);if(notes.length<10)return send(res,400,{error:'실제 검수 내용 10자 이상을 입력해 주세요.'});
      rep.humanReview={status:'approved',notes,reviewedAt:new Date().toISOString()};await persist();return send(res,200,{ok:true});
    }
    if(u.pathname==='/api/admin/meeting-complete'&&req.method==='POST'){
      if(!checkOrigin(req)||!adminAllowed(req))return send(res,403,{error:'관리자 인증 실패'});
      const b=await readBody(req);const db=await store(),m=db.meetings.find(x=>x.id===b.id);if(!m)return send(res,404,{error:'상담을 찾지 못했습니다.'});
      const discountPct=Number(b.discountPct);if(!Number.isInteger(discountPct)||discountPct<1||discountPct>30)return send(res,400,{error:'할인율은 1~30 정수만 가능합니다.'});
      m.status='completed';const code='SEEN-'+randomBytes(4).toString('hex').toUpperCase();db.coupons.push({code,discountPct,meetingId:m.id,expiresAt:Date.now()+30*86400000,status:'active'});await persist();return send(res,200,{code,discountPct,note:'상담 완료가 확인되어 발급된 쿠폰. 고객에게 별도로 전달해 주세요.'});
    }

    if(req.method==='POST'&&u.pathname==='/api/marketing-report'){const b=await readBody(req);const data=await marketingReport(b);return send(res,data.code==='AUTH_REQUIRED'?403:200,data);}
    if(req.method==='GET'&&u.pathname==='/api/status')return send(res,200,{naver:hasNaver,places:Boolean(PLACES_KEY),ai:Boolean(OPENAI_KEY),pagespeed:true});
    if(req.method==='POST'&&u.pathname==='/api/search'){
      const b=await readBody(req);const q=clean(b.query,80),area=clean(b.area,80);if(!q)return send(res,400,{error:'상호명을 입력하세요.'});
      if(!hasNaver&&!PLACES_KEY)return send(res,503,{error:'상호 검색 API 미설정: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 또는 GOOGLE_PLACES_API_KEY가 필요합니다.'});
      const items=await searchBusinesses(q,area);return send(res,200,{query:q,area,items,warning:'동명이인·유사 상호가 있을 수 있습니다. 정확한 업체를 직접 확인하세요.'});
    }
    if(req.method==='POST'&&u.pathname==='/api/local-rank'){
      const b=await readBody(req);const result=await localRank(b);return send(res,200,result);
    }
    if(req.method==='POST'&&u.pathname==='/api/diagnose'){
      const b=await readBody(req);if(!clean(b.name))return send(res,400,{error:'상호명을 입력하세요.'});
      if(b.website&&!publicHttpsUrl(b.website))return send(res,400,{error:'홈페이지 주소는 공인 HTTPS 주소만 허용합니다.'});
      const report=await diagnose(b);return send(res,200,report);
    }
    return send(res,404,{error:'페이지를 찾지 못했습니다.'});
  }catch(e){const msg=clean(e.message);console.error('Request error',msg);send(res,/API 연동이 필요|_NOT_CONFIGURED|API 미설정/.test(msg)?503:500,{error:'요청을 처리할 수 없어요. 입력값과 API 설정을 확인해 주세요.',details:process.env.NODE_ENV==='development'?msg:undefined});}
});
if (process.env.NODE_ENV!=='test') server.listen(PORT,()=>console.log(`SEEN GROW MVP: http://localhost:${PORT}`));
export {server};
