# 원카드 온라인

최대 5인 온라인 원카드. 54장 고정 덱이라 깔린 카드를 카운팅할 수 있고, 덱이 소진되면 깔린 카드만 다시 섞여 덱이 됩니다.

## 내 컴퓨터에서 실행

```
node server.js
```

브라우저에서 http://localhost:3000 접속. (Node 18 이상 필요, 설치할 패키지 없음)

## Render에 배포하기

1. GitHub 저장소를 만들고 이 폴더의 파일(`server.js`, `index.html`, `package.json`, `.gitignore`, `README.md`)을 올립니다.
2. render.com에 GitHub 계정으로 로그인합니다.
3. New → Web Service → 방금 만든 저장소를 선택합니다.
4. 설정:
   - Runtime: Node
   - Build Command: 비워두거나 `npm install`
   - Start Command: `npm start`
   - Region: Singapore 권장 (한국에서 가장 가까움)
5. Create Web Service를 누르면 `https://○○○.onrender.com` 주소가 생깁니다. 이 주소를 친구들에게 공유하면 됩니다.

PORT는 서비스가 자동으로 지정하며 코드가 `process.env.PORT`를 읽으므로 따로 설정할 것이 없습니다.

## 운영 시 주의

- 서버 인스턴스는 반드시 1개로 유지하세요. 방 상태가 서버 메모리에 있어서 2개 이상이면 방이 갈라집니다.
- 서버를 재시작하거나 재배포하면 진행 중인 게임이 사라집니다.
- 무료 플랜은 접속이 없으면 서버가 잠들 수 있습니다. 첫 접속이 느려지거나 연결이 끊길 수 있으니 게임 전에 주소를 한 번 열어 깨워 두세요.
