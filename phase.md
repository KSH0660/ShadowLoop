# Shadow Loop 확장 작업 (phase.md)

> `/loop`로 위에서부터 한 Phase씩 실행한다. 각 Phase 끝에서 `npm run check`로 검증하고,
> 영상/해설 변경은 커밋만(푸시는 사용자 지시 시) — 단, 이 저장소 작업 규칙상 완료 시
> 지정 브랜치로 커밋/푸시한다.

## 전체 목표
1. 영상을 22 → **약 40~50개**로 확장 (Modern Family 위주 + 다른 시트콤/드라마).
2. 자막 데이터를 더 잘 활용 (단어 해설 강화·탭 상세).
3. 단어 해설을 **토익 700 수준**도 이해하는 쉽고 자세한 형식으로 전환.
4. 홈/보관함 외 **단어장 탭** 추가 (저장·복습·랜덤·난이도별, 이후 퀴즈·자주 틀린 단어).

## 확정된 의사결정
- 영상 목표 수: 약 40~50개 (수동 자막 확보 가능 범위 내; 미달 시 확보분까지).
- 풍부한 해설: 자막 밑 칩은 간결(단어+쉬운 뜻) 유지, **탭하면 상세 시트**가 열림.
- 해설 스키마: 풍부 형식으로 정의하되 **모든 필드 optional**(하위호환). 새 영상부터 풍부하게, 기존 489개는 후반 Phase에서 배치 보강.
- 퀴즈: 단어장 기본 기능 안정화 후 별도 Phase.

## 미해결/실행 중 판단할 항목
- 시트콤 후보(Big Bang Theory, Friends, Brooklyn 99, The Office 등) 중 **수동 자막 보유 클립**만 채택 — 실제 확보 수에 따라 배치 개수 조정.
- "난이도"는 별도 점수 대신 기존 `type`(word/phrase/idiom)을 1차 기준으로 사용, 필요 시 후속 보강.

---

## 단어 해설 스키마 (Phase 1에서 확정, 모든 추가 필드 optional)
기존: `{ term, ko, type }` (그대로 유지 = 칩 인라인 표시용)
추가(풍부 해설, 토익 700 수준 쉬운 한국어):
- `easy`  — 쉬운 뜻(아주 풀어 쓴 한 줄)
- `nuance`— 실제 뉘앙스/느낌
- `when`  — 자주 쓰는 상황
- `ex`    — 쉬운 예문(영어)
- `exKo`  — 예문 한국어 해석
- `vs`    — 비슷한 단어와의 차이
- `tip`   — 헷갈리는 포인트

> `attachGlossary()`가 배열을 통째로 넘기므로 빌드 스크립트 수정 불필요. 렌더링/작성 가이드만 갱신.

---

## 진행 현황 (이 세션)
- **코드 페이즈 완료**: Phase 1·5·6·7 (단어 상세 시트 + 단어장 탭: 목록/복습/퀴즈). `npm run check` 통과.
- **Phase 2 완료**: Modern Family(TBS) 수동 자막 8개 추가 + 풍부 글로싱(136항목) → 30개.
- **Phase 3~4 완료**: Friends 8 + The Office 2 추가 + 글로싱(53항목) → **누계 40개**(목표 40~50 하한 도달). curator 스킬의 `web_embedded` 우회로 클라우드 환경에서도 자막 다운로드 성공.
- **Phase 8 착수**: 견본 1개 영상(ykN0VZiEDr8) 해설 4건을 풍부 형식으로 전환. 나머지 기존 해설은 배치 반복으로 후속 진행(파이프라인 `npm run build:glossary` 동작 확인).
- **남은 것**: Phase 4 상한(45~50)까지 추가 확장(선택), Phase 8 기존 영상 해설 풍부화 배치.

## Phase 목록

### Phase 1 — 풍부한 단어 해설 기반 (스키마 + 탭 상세 시트) ✅
- [x] glossary 스키마에 위 optional 필드 정의(파일 상단 주석 `data/glossary.json` 갱신 — `"//schema"` 추가).
- [x] `index.html`: 단어 상세 시트 `#wordSheet` 추가(기존 `#notesSheet` 패턴 복제).
- [x] `app.js`: `renderGlossary()`의 `.gloss-item`을 탭 가능하게 → 탭 시 해당 단어의 풍부 필드를 `#wordSheet`에 렌더(`openSheet("word")`). 칩 자체는 `term`+`ko`로 간결 유지. 풍부 필드 없으면 있는 것만 표시.
- [x] `styles.css`: 단어 상세 시트 + 필드 라벨(쉬운 뜻/뉘앙스/상황/예문/해석/유사어/포인트) 스타일.
- [x] `.claude/skills/youtube-curator/SKILL.md`: 글로싱 가이드를 **토익 700 수준 + 풍부 필드** 기준으로 갱신(쉬운 한국어, 사전 덤프 금지).
- [x] 견본으로 기존 영상 1개(ykN0VZiEDr8)의 해설 4건을 풍부 형식으로 업그레이드(검증용 데이터).
- 완료 기준: `npm run check` 통과 + 단어 칩 탭 시 상세 시트가 뜨고, 풍부 필드 유무에 따라 정상 렌더. 기존 간결 항목도 깨지지 않음.

### Phase 2 — 영상 확장 배치 A: Modern Family (목표 +8~12) ✅
- [x] `/youtube-curator`로 Modern Family **수동 자막** 클립 8개 추가(`videos.json`) — TBS 채널, 전부 manual `en` 자막 확인.
- [x] 추가분 8개를 Phase 1 풍부 형식으로 글로싱(136개 항목, 약 99개 풍부 필드 포함).
- [x] `npm run build:transcripts` → `npm run build:glossary` → `npm run check`.
- 완료 기준: 새 영상이 홈에 보이고 재생/자막/해설 정상. **누계 30개 영상**(모던 패밀리 7→14).

### Phase 3 — 영상 확장 배치 B: 다른 시트콤/드라마 후보 (목표 +8~12) ✅
- [x] Friends(8개)·The Office(2개) **수동 자막** 클립 탐색·채택 — 둘 다 TBS/공식 채널 manual `en`. (Parks & Rec, Brooklyn 99는 plain `en` manual 트랙이 없어 제외.)
- [x] 글로싱(53개 항목) + 빌드 + check.
- 완료 기준: 새 카테고리 `미드 · 프렌즈`, `미드 · 오피스` 추가. **누계 40개**.

### Phase 4 — 영상 확장 배치 C: 목표 40~50개 도달 ✅(하한 도달)
- [x] Friends·The Office 추가로 **40개** 도달(목표 40~50의 하한). 추가 여력 있으면 동일 방식으로 45~50까지 확장 가능.
- [x] 글로싱 + 빌드 + check.
- 완료 기준: 누계 **40개**. 카테고리 분포 — 모던 패밀리 14 / 프렌즈 8 / TED 5 / 키앤필 4 / 멀레이니 3 / 타블로 2 / 하산 민하지 2 / 오피스 2.

### Phase 5 — 단어장 탭 기반 (저장 + 목록) ✅
- [x] `index.html` tabbar에 `#tabWords`(`#/words`) 추가, `#wordsView` 뷰 추가.
- [x] `app.js`: `route()`/`setActiveTab()`/`els`에 단어장 연결, `showWords()`/`renderWords()`.
- [x] localStorage `shadowloop:v1:vocab` 스키마: `{ words: [{ id, term, ko, type, easy?, …, video, videoTitle, seg, addedAt, correct, wrong }] }`.
- [x] 단어 저장 액션: 단어 상세 시트(`#wordSheet`)에 "단어장에 저장" 버튼 → vocab에 적재(중복 토글).
- [x] 단어장 목록 렌더(최근순 + 출처 영상/구간 표시, 삭제).
- 완료 기준: 단어 저장→단어장 탭에서 확인·삭제, 새로고침 후 유지. `npm run check` 통과.

### Phase 6 — 단어장 복습 (랜덤 보기 + 난이도별 보기 + 플래시카드) ✅
- [x] 랜덤 보기(셔플) / 난이도별(=type) 필터.
- [x] 플래시카드(앞: 단어 / 뒤: 쉬운 뜻+예문, 탭으로 뒤집기).
- [x] 복습 진행 표시(n / 총 + 이전/다음/다시 섞기).
- 완료 기준: 랜덤·난이도별·플래시카드 동작, 모바일 단일 집중 UI 유지.

### Phase 7 — 퀴즈 + 자주 틀린 단어 ✅
- [x] 퀴즈(4지선다 뜻 맞히기) — 정답/오답을 vocab 레코드에 기록(`correct`/`wrong` 카운트).
- [x] "자주 틀린 단어" 보기(목록의 `자주 틀림` 필터 = 오답 카운트 정렬).
- 완료 기준: 퀴즈 1라운드 후 결과·오답 누적, 자주 틀린 단어 목록 반영.

### Phase 8 — 기존 489개 해설 점진적 보강 (배치 반복)
- [ ] 영상 단위로 기존 glossary 항목을 풍부 형식(토익 700 수준)으로 업그레이드.
- [ ] `npm run build:glossary`(재다운로드 없이 머지) → check.
- 완료 기준: 배치별 영상의 해설이 풍부 형식으로 전환(전체 완료 시 489개 보강 종료).

## 공통 완료 기준 / 규칙
- 각 Phase: `npm run check` 통과, 모바일 단일 집중 UI·한국어 UI 유지.
- 데이터(`videos.json`/`data/transcripts.json`/`data/glossary.json`)는 손으로 안 깨고 빌드로 생성.
- 작업은 지정 브랜치 `claude/learning-app-phase-planning-s13h6f`에 커밋/푸시(사용자 규칙).
