# SEEN GROW — AI × HUMAN Marketing Diagnosis Platform

> **실행 가능한 홈페이지 MVP (상용 배포 전 프로토타입)**  
> AI 사전 진단 → 근거 표시 → 상세 판독 리포트 → 체험상품 구매 요청 → 마케터 미팅 → 관리자 검수/쿠폰 발급.
>
> 현재 실시간 결제, 소유자 통계 연동, AI 검색 인용 자동 집계, 자동 예약 확정은 구현되지 않았습니다. 이것들은 연동/운영 단계입니다.

## 빠른 실행

Node.js **20 이상** 필요. 별도 `npm install` 없이 동작하도록 외부 패키지 의존성이 없습니다.

```bash
cd seen-grow-platform
npm test
npm start
```

브라우저: **http://localhost:3000**

- 홈페이지: `/`
- 가상 시연 리포트: 홈페이지의 `가상 샘플 리포트 먼저 보기` 클릭. **실측 데이터가 아닌 것**을 명시합니다.
- 관리자 페이지: `/admin` (환경변수 `ADMIN_TOKEN` 필요)

기본 동작은 API 키 없이도 테스트할 수 있습니다. 단, API를 연결하지 않았다면 진짜 가게의 검색 건수·지도 결과·검색량 등을 **수집 불가**로 표시하며 가짜 숫자를 생성하지 않습니다.

## 실제 공개 데이터 연동

`sample.env`를 복사해서 `.env`를 만들고 발급받은 키를 작성하세요. **비밀키를 HTML/JS에 넣으면 안 됩니다.**

```bash
# Node.js 20+, 파일 기반 환경변수 로드
node --env-file=.env server.js
```

| 환경변수 | 목적 | 상태 |
|---|---|---|
| `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | 네이버 지역/블로그/카페/웹 검색, 데이터랩 | 구현 (API 키 필요) |
| `GOOGLE_PLACES_API_KEY` | 구글 장소명/주소/리뷰 누적 수, Nearby 비교 표본 | 구현 (API 키·과금 설정 필요) |
| `PAGESPEED_API_KEY` | 공식 웹사이트 SEO / 성능 점검 | 선택 사항 |
| `OPENAI_API_KEY` | 근거 범위 내 추가 AI 문장 초안 | 선택 사항, 자동 결과는 **미검수** |
| `OPENAI_MODEL` | OpenAI Responses API 모델명 | 접근 가능한 모델로 설정 |
| `ADMIN_TOKEN` | 개발용 관리자 접근 토큰 | 운영 화면에 필요 |
| `PORT` | 웹서버 포트 | 기본 3000 |
| `COOKIE_SECURE=1` | HTTPS에서 Secure 세션 쿠키 | 운영 HTTPS에서 권장 |

공식 API 문서:
- https://developers.naver.com/docs/serviceapi/search/local/local.md
- https://developers.naver.com/docs/serviceapi/search/blog/blog.md
- https://developers.naver.com/docs/serviceapi/search/cafearticle/cafearticle.md
- https://developers.naver.com/docs/serviceapi/datalab/search/search.md
- https://developers.google.com/maps/documentation/places/web-service/text-search
- https://developers.google.com/maps/documentation/places/web-service/nearby-search
- https://developers.google.com/maps/documentation/places/web-service/place-details
- https://developers.google.com/speed/docs/insights/v5/get-started
- https://platform.openai.com/docs/api-reference/responses

**Google Places API**는 필드 종류에 따라 과금할 수 있으니 Cloud Console 예산 제한을 걸고 테스트하세요. 플랫폼 약관의 표시·캐싱·보존 제한을 반드시 준수하세요.

## 화면 구성

1. **브랜드 메인** — SEEN 레드(#C70E2E), 블랙/오프화이트, 인물 이모지 캐릭터. 아이폰 Memoji 이미지 *원본*이 아니라 OS별 표준 이모지 플레이스홀더입니다.
2. **공개 진단** — 상호 / 지역 / 업종 / 공식 사이트. 실제 API가 있으면 동명이인 구분 후 진단.
3. **회원 기능** — 이메일 / 비밀번호 회원가입과 로그인, 최근 12개월 데이터랩 기간 요청. 과거의 사업주 리뷰·저장 수를 복원하지 않습니다.
4. **리포트** — 판세 / 확인 신호 / 기회 / 30일 실행 전략의 4장 구성을 포함. 표본·미확인·검증을 구분하고 상세 지표표와 출력(PDF로 저장 기능은 브라우저 인쇄) 제공.
5. **SEEN SHOP** — 바이럴 원고 9,900원, 검색광고 세팅 50,000원, 체험단 모집·관리 10,000원, 종합마케팅/인스타대행 견적 요청.
6. **장바구니/구매 요청** — 수량과 합계 계산, 서버에서 가격 재계산, 문의 접수. 실제 카드 승인이나 대금 결제는 발생하지 않습니다.
7. **전문가 상담** — 상담 요청 접수(요청 ≠ 예약 확정), 실제 대면 미팅 이후 담당자가 관리자 화면에서 쿠폰 발급.
8. **관리자** — 구매/미팅 요청 열람, 전문가 실제 검수 기록, 쿠폰 발급. 쿠폰을 입력한 구매 요청은 할인된 *견적*으로 계산됩니다.

## 데이터 정확성 (서비스 신뢰의 핵심)

| 지표 | 가능한 것 | 현재 불가능하거나 추가 연동이 필요한 것 |
|---|---|---|
| 지역 몇 위 | 특정 검색어와 위치 조건으로 반환된 **API 표본 내 위치** | 동네 모든 동종업소의 공식 순위 / 시장점유율 |
| 블로그 / 카페 | 검색 API 결과 총량과 날짜가 있는 일부 표본 | 정확한 업체 자체 홍보 발행량, 체험단 총 운영 수 |
| 검색어 트래픽 | 네이버 데이터랩의 **상대 검색 관심도** | 상호명만으로 정확한 월간 검색 횟수·방문자 수 |
| 구글 리뷰 | 장소 선택 후 현재 누적 평점 수 | 과거 매월 증가량(별도 이력 필요) |
| 네이버 리뷰, 플레이스 찜 | 자료 제출·연동 설계 및 화면 상태 구분 | 공개 API로 모든 업체의 정확한 값 일괄 수집 |
| 12개월 통계 | 회원의 최근 12개월 **상대 검색 트렌드** (API 연동 시), 저장한 진단 이력 | 가입만으로 12개월 과거 전체 지표 자동 복원 |
| AI 검색 인용 | 테스트 항목과 스냅샷 설계 방향 제시 | 실제 서비스별 질문 실행/출처 기록/집계 자동화 |
| 체험단 활동 | 브랜드 캠페인 운영 장부 등록 후 집계 설계 | 검색 결과 총량을 실제 체험단 운영 건수로 간주 |

**위기감을 유발할 목적으로 가짜 경쟁 순위, 누락된 성과, 가상의 위기 점수를 생성하지 않습니다.** 표시된 위험/개선 과제는 확인된 데이터 또는 추가 확인 사항과 함께 제공합니다.

## 기본 API 라우트

```text
GET  /api/status
GET  /api/products
POST /api/search                # 상호·지역별 업체 확인
POST /api/local-rank            # 특정 공급사 표본 위치
POST /api/full-diagnosis       # 30일/회원12개월 통합 보고서
POST /api/marketing-report     # 전 버전 호환 보고서
POST /api/diagnose             # 전 버전 호환 사전 분석
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/me
GET  /api/my-reports
POST /api/meeting
POST /api/orders               # **미결제** 요청 접수
GET  /api/admin/queue
POST /api/admin/review
POST /api/admin/meeting-complete
```

### 간단한 진단 API 요청

```bash
curl -X POST http://localhost:3000/api/full-diagnosis \
  -H 'Content-Type: application/json' \
  -d '{"name":"예시 상호","area":"서울 성수동","category":"카페","period":"30d","acceptPrivacy":true}'
```

### 가상 샘플

```bash
curl -X POST http://localhost:3000/api/full-diagnosis \
  -H 'Content-Type: application/json' \
  -d '{"demo":true}'
```

반환된 모든 수치는 *가상 샘플*임을 분명히 표기합니다.

## 운영·보안 관련 주의

- 사용자 계정/상담/요청/보고서를 `data/store.json`에 저장하는 **단일 서버용 JSON 파일 저장소**입니다. 여러 서버 배포, 데이터 백업, 암호화, 접근기록, 자동 삭제, 법적 고지 등 상용 수준에 못 미칩니다.
- 실제 서비스를 공개하려면 PostgreSQL 같은 DB, 이메일 인증·비밀번호 재설정·권한 관리, 개인정보처리방침과 동의/보유기간, CSRF 보호 정책 보강, 운영자 접근 감사로그, API 과금 제한, 취약점 검사, TLS/HTTPS 배포가 필요합니다.
- **PG 결제 계약과 웹훅 검증**이 없는 상태입니다. 구매 요청을 결제 완료로 처리하면 안 됩니다.
- 사업자 정보, 서비스 제공기간, 공급조건, 환불 규정, 부가세 표시는 출시 전에 확정해야 합니다.
- 허위 영수증 리뷰, 비용을 숨긴 광고 후기, 정당한 사용 경험이 없는 체험단 리뷰는 제공하지 않습니다.
- 메인화면에는 12년 경력·대학원 재학 문구를 사용자가 제시한 정보대로 **초안**으로 표기했습니다. 상용화 전 사실확인이 필요합니다.
- AI 초안은 미검수로 표시. 실제 전문가가 리뷰한 기록이 있더라도 검수 담당자 신원·로그 관리 시스템은 출시 전 보강해야 합니다.

## 추천 다음 개발 단계

1. 관리자 인증/DB/개인정보 정책 완성 → 안정적인 상용 기반 확보
2. 네이버·Google 실제 API 키 연결, 비용·표시 약관 검증
3. 사업주 소유 통계(GA4, Search Console, 플레이스) 권한 연동
4. AI 검색 질문 세트·기간별 출처 스냅샷 자동 기록
5. 반복 측정 / 경쟁사의 동종업종·지역 필터 / 지표별 유효성 검증
6. PG 실결제와 영수증·환불 / 쿠폰 사용 완료 처리
7. 전문가 마이페이지, 고객별 전문가 검수 승인·납품 파일·수정 내역
8. SEEN 고유 3D 인물 이모지 에셋 제작 후 기존 OS 이모지 교체
