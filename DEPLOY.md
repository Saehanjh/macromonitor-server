# MacroMonitor 백엔드 공개 배포 (Render 무료)

폰을 셀룰러로 쓰거나 PC와 다른 네트워크에 있어도 어디서나 접속되게 만드는 가이드.
로컬 git 커밋까지는 이미 완료되어 있습니다. 아래 5단계만 따라 하면 됩니다.

---

## 1) GitHub에 코드 올리기

1. https://github.com 가입(이미 있으면 로그인)
2. 우측 상단 **+** → **New repository**
   - Repository name: `macromonitor-server`
   - **Public** 선택, README/.gitignore 추가는 **체크 해제**(빈 저장소)
   - **Create repository**
3. 이 폴더 터미널(`macromonitor-server`)에서 — `<username>`을 본인 깃허브 아이디로 교체:
   ```powershell
   git branch -M main
   git remote add origin https://github.com/<username>/macromonitor-server.git
   git push -u origin main
   ```
   처음 push 시 브라우저가 열려 GitHub 로그인을 요구합니다 → 로그인하면 업로드됩니다.

> ✅ `.env`(FRED 키)는 `.gitignore`로 제외되어 GitHub에 **올라가지 않습니다**. 안전합니다.

---

## 2) Render에 배포

1. https://render.com 접속 → **Get Started** → **GitHub 계정으로 로그인** 권장
2. 대시보드 → **New +** → **Blueprint**
3. 방금 만든 `macromonitor-server` 저장소 선택 → Render가 `render.yaml`을 자동 인식
4. **FRED_API_KEY** 입력란이 뜨면 발급받은 키를 붙여넣기:
   ```
   발급받은 본인의 FRED API 키를 입력합니다. 키는 문서·소스·클라이언트 환경변수에 저장하지 마세요.
   ```
5. **Apply / Create** → 빌드 시작 (약 3~5분)

---

## 3) 공개 URL 확인 & 테스트

- 배포 완료되면 대시보드 상단에 주소가 표시됩니다:
  `https://macromonitor-server.onrender.com` (이름이 선점됐으면 뒤에 임의 문자 붙음)
- 브라우저에서 `그-주소/health` 열기 → `{"status":"ok", "apiVersion":"2026-09-10", "capabilities":[...]}`가 보여야 최신 서버입니다. `capabilities`가 없으면 아직 구버전 배포본입니다.
- 또한 `그-주소/api/news?window=d3` 열어 실제 뉴스 JSON 확인
- 시세 배치 확인: `그-주소/api/yahoo?symbols=NVDA&interval=1d&range=1d`에서 `items` 배열이 반환되는지 확인합니다. Yahoo가 일시 제한될 때는 `source:"fallback"`으로 지연 시세가 표시될 수 있습니다.

Render의 Environment에 `PERSONAL_SESSION_SECRET`를 추가하고 32자 이상의
임의의 긴 문자열을 입력하세요. 이 값은 모바일 앱에 넣지 않습니다. 앱이 처음
개인 브리핑·이벤트를 열 때 설치별 세션을 자동으로 발급받습니다.

---

## 4) 앱(APK)을 이 주소로 재빌드

1. `macromonitor-app/eas.json`의 `EXPO_PUBLIC_API_BASE_URL`이
   3단계의 **실제 주소와 같은지** 확인 (다르면 preview·production 둘 다 수정)
2. 재빌드:
   ```powershell
   cd ..\macromonitor-app
   eas build --profile preview --platform android
   ```
3. 완료 후 나오는 링크를 폰에서 열어 APK 설치 → **이제 Wi-Fi/셀룰러 어디서나 실시간 동작**

---

## 5) 코드 수정 후 재배포 (이후 반복)

```powershell
cd macromonitor-server
git add -A
git commit -m "수정 내용"
git push
```
→ Render가 자동으로 다시 배포합니다(`autoDeploy: true`). 배포가 멈추면 Render의 **Manual Deploy → Clear build cache & deploy**를 선택하세요.

---

## ⚠️ 무료 플랜 특성 (알아두기)

- **15분간 요청이 없으면 서버가 잠듭니다.** 다음 첫 접속이 ~50초 느립니다(콜드 스타트).
  앱 첫 화면이 잠깐 느릴 수 있으나, 한 번 깨면 이후엔 빠릅니다.
- 잠든 동안엔 **푸시 알림 cron이 멈춥니다.** 알림을 상시 받으려면:
  - 유료(Starter $7/월)로 always-on, 또는
  - https://cron-job.org (무료)에서 10분마다 `그-주소/health`를 호출해 깨어있게 유지
- 푸시 토큰 저장소(`data/`)는 재배포 시 초기화됩니다(앱 재실행 시 자동 재등록되므로 문제 없음).
