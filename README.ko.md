# PocketClaude

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**컴퓨터에서 실행 중인 Claude Code 세션을 휴대폰이나 브라우저에서 원격으로 모니터링·조작**하는 셀프호스팅 PWA.
로그인된 로컬 `claude` CLI를 사용하므로(Max/Pro 구독으로 동작, **추가 API 비용 없음**) Cloudflare 터널을 통해 어디서든 접속할 수 있습니다.

- 모든 Claude Code 대화의 진행 상황을 실시간으로 확인
- 휴대폰에서 프롬프트를 보내 대화를 이어가거나 새 대화 시작
- **매번 승인**: Claude가 도구를 사용하기 전 푸시 알림으로 허용/거부 선택
- **작업 병렬 실행**: 다른 세션은 동시 실행, 바쁜 세션에는 자동 대기열
- 키 기반 로그인(최초 실행 시 자동 생성)
- 깔끔한 Markdown 렌더링(DOMPurify 정화), 코드 하이라이트, 이미지 붙여넣기/첨부
- Claude가 생성한 이미지/오디오/영상/PDF 보기, dev server를 휴대폰에서 미리보기
- 내장 파일 브라우저 + Markdown 리더
- **8개 UI 언어**, 라이트/다크 테마, 사고 강도 조절, 음성 입력
- 앱으로 설치 가능, 작업 완료 시 푸시 알림(기기 언어로)
- 오프라인 / 방화벽 내에서도 동작(에셋 전부 자체 호스팅)

> ⚠️ **실행 중인 그 컴퓨터만 제어합니다.** A 컴퓨터에서 실행하면 A의 Claude만 조작할 수 있습니다. 로컬 `~/.claude`를 읽고 로컬 `claude` CLI를 호출합니다.

---

## 요구 사항

- **Node.js 18+**
- **Claude Code / Claude Desktop 설치 및 로그인**(Max 또는 Pro) — 터미널에서 `claude`가 실행되면 OK
- (원격 접속용) **cloudflared** — 사전 설치 불필요, 아래처럼 `npx`로 실행

**Windows / macOS / Linux** 지원(CLI 경로와 데이터 디렉터리는 OS별 자동 감지).

## 설치

```bash
git clone https://github.com/SakuraNeco/PocketClaude.git
cd PocketClaude
npm install
```

## 실행

```bash
npm start
```

다음이 보이면 성공:

```
PocketClaude server → http://localhost:3000
login key:   xxxxxxxxxxxxxxxxxxxxxxxx
claude CLI:  /path/to/claude
```

<http://localhost:3000> 을 열고 시작 로그의 **login key**를 입력(기기당 한 번).

> 키는 `.auth-token`(gitignore됨)에 저장됩니다. 삭제 후 재시작하면 새 키가 생성되며 `CC_AUTH_TOKEN` 환경 변수로도 지정 가능합니다. `claude CLI` 감지가 틀리면 `.env.example`을 `.env`로 복사해 `CLAUDE_PATH`를 지정하세요.

## 휴대폰 / 외부에서 접속(Cloudflare 터널)

```bash
npm run tunnel
```

`https://xxxx.trycloudflare.com` 주소가 출력됩니다 — 휴대폰에서 열고 login key 입력. 고정 주소가 필요하면 Cloudflare [이름 있는 터널](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)로 ingress를 `http://localhost:3000`에 연결하세요.

> ⚠️ **자체 도메인(이름 있는 터널) 사용 시**: Cloudflare 관리형 WAF 규칙이 `/node_modules/…` 등을 403 처리해 Vite dev server의 `/proxy` 미리보기가 깨집니다. Cloudflare 대시보드에 커스텀 규칙을 추가하세요: Hostname이 서브도메인과 같음 → 동작 **Skip**(모든 관리형 규칙 + 나머지 모든 커스텀 규칙 체크). PocketClaude는 자체 키 인증이 있어 WAF에 의존하지 않습니다.

## 앱 설치 + 푸시 알림

1. 휴대폰 브라우저에서 https 주소 열기
2. 「홈 화면에 추가」
3. 홈 화면 아이콘으로 열고 **알림 켜기** 탭(iOS 웹 푸시는 홈 화면 추가 후에만 동작)

---

## 사용법

- 상단 「**보낼 대상**」에서 조작할 대화를 고르고 메시지를 전송.
- **권한 모드**:
  | 모드 | 동작 |
  |------|------|
  | 매번 승인 `interactive` | 모든 도구 호출을 휴대폰으로 푸시, 허용/거부 탭(120초 무응답 시 자동 거부) |
  | 자동 편집 `acceptEdits`(기본) | 파일 편집 자동 허용 |
  | 완전 자동 `bypassPermissions` | 전부 허용 — 가장 강력하지만 가장 무방비 |
  | 플랜 모드 `plan` | 계획만, 변경 없음 |
- **모델**: 기본 / Fable 5 / Opus / Sonnet / Haiku · **사고 강도**: 기본 / 낮음 / 중간 / 높음 / 매우 높음 / 최대
- 우측 상단에서 **UI 언어**(8종)와 **테마** 전환. 입력창 옆에 **음성 입력** 버튼.
- 사이드바 **파일** 버튼으로 세션 폴더 탐색, `.md`는 내장 리더로 열림.

### 참고 / 알려진 제한

- **세션당 동시 1개 작업**. 실행 중 세션에 보내면 대기열에 들어가 완료 후 자동 전송. 다른 세션은 병렬 실행.
- **PocketClaude 자신의 세션은 웹에서 조작 불가**(서버가 재시작되어 죽음) — 자동 차단.
- **데스크톱에 열려 있는 대화**에 보내면 파일에는 기록되지만 그 창은 다시 열어야 보입니다.
- **자동 재시작 없음**: 터미널 종료 / 재부팅 / 크래시 시 중지. 상주시키려면 `pm2`, `launchd`(mac), 작업 스케줄러(win)를 사용하세요.

## 보안

- PWA 셸 외 **모든 API / WebSocket / 파일 스트리밍 / 프록시에 키 필요**(timing-safe 비교, HttpOnly 쿠키).
- `/media`, `/files`는 홈 디렉터리 내부로 제한(경로 경계 검사 포함).
- 매번 승인 브리지는 **fail-closed**: 서버에 연결 불가 시 거부.
- 모든 Markdown 출력은 DOMPurify 정화. 텍스트 파일(HTML 포함)은 `text/plain`으로 제공.
- `/proxy`는 세션에 등장한 포트만 연결 가능(`CC_PROXY_ALLOW`로 추가).
- `/auth` 무차별 대입 억제. OS 임시 디렉터리 아래 세션은 대상에서 제외.
- `.audit.log`에 로그인·전송·중지·권한 결정을 기록.

## 환경 변수(모두 선택 — `.env.example` 참고)

| 변수 | 설명 |
|------|------|
| `PORT` | 서버 포트(기본 3000) |
| `CLAUDE_PATH` | `claude` CLI 경로(미설정 시 자동 감지) |
| `CC_AUTH_TOKEN` | 로그인 키(미설정 시 `.auth-token`에 자동 생성) |
| `CC_PROXY_ALLOW` | `/proxy` 추가 허용 포트(쉼표 구분) |
| `VAPID_SUBJECT` | Web Push 연락처 `mailto:` |

VAPID 키, 로그인 키, 푸시 구독, 업로드는 **설치별로 생성**되며 gitignore 처리됩니다.

## 개발

```bash
npm test        # node --test — 순수 함수 단위 테스트
node --check server.js
```

CI는 Node 18/20/22에서 문법 검사 + 테스트를 실행합니다.

## License

MIT
