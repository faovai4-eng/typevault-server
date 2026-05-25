# TypeVault Server

Backend API that stores TypeVault user libraries in your Google Drive folder.

## Config

`.env` is already configured for local testing:

```env
PORT=8787
GOOGLE_APPLICATION_CREDENTIALS=C:\Users\JM\Documents\Downloads\typevault-cloud-e19570f7555a.json
GOOGLE_OAUTH_CLIENT_PATH=C:\Users\JM\Desktop\ex for illustrotor\typevault-server\oauth-client.json
GOOGLE_OAUTH_TOKEN_PATH=C:\Users\JM\Desktop\ex for illustrotor\typevault-server\oauth-token.json
GOOGLE_DRIVE_FOLDER_ID=1Mk7GbQ5CkMz_u81nuUr2NJBZkkHo7Waj
TYPEVAULT_API_KEY=typevault-local-dev-key
```

Do not put the Google service account JSON inside the Illustrator plugin. Keep it only on the server.

## Render Environment Variables

On Render, do not use local Windows paths like `GOOGLE_OAUTH_CLIENT_PATH` or `GOOGLE_OAUTH_TOKEN_PATH`. Render cannot access files from your PC.

Use these variables instead:

```env
GOOGLE_DRIVE_FOLDER_ID=1Mk7GbQ5CkMz_u81nuUr2NJBZkkHo7Waj
TYPEVAULT_API_KEY=your-strong-secret
GOOGLE_OAUTH_CLIENT_JSON={"web":{...}}
GOOGLE_OAUTH_TOKEN_JSON={"access_token":"...","refresh_token":"...","scope":"...","token_type":"Bearer","expiry_date":123}
```

Paste each JSON as one line.

## Important Google Drive Note

The service account can check the folder, but uploads to a personal Google Drive can fail because service accounts do not have personal Drive storage quota. For your own Drive folder, use OAuth once as the Drive owner.

## Connect Your Google Account With OAuth

1. Google Cloud Console > APIs & Services > Credentials.
2. Click `Create Credentials > OAuth client ID`.
3. If asked, configure OAuth consent screen first.
4. Application type: `Web application`.
5. Authorized redirect URI:

```text
http://localhost:8787/oauth2callback
```

6. Download the client JSON.
7. Rename it to `oauth-client.json`.
8. Put it here:

```text
C:\Users\JM\Desktop\ex for illustrotor\typevault-server\oauth-client.json
```

9. Start server, then open:

```text
http://localhost:8787/auth/google?key=typevault-local-dev-key
```

10. Sign in with the Google account that owns the `TypeVault Users` Drive folder.

After this, `oauth-token.json` will be created and uploads will use your Google account.

## Run

```powershell
cd "C:\Users\JM\Desktop\ex for illustrotor\typevault-server"
npm install
npm start
```

Open:

```text
http://localhost:8787/health
```

Drive permission test:

```powershell
curl.exe -H "x-typevault-key: typevault-local-dev-key" http://localhost:8787/drive/check
```

## Upload Test

```powershell
curl.exe -X POST `
  -H "x-typevault-key: typevault-local-dev-key" `
  -F "folder=library" `
  -F "name=styles.json" `
  -F "file=@C:\path\to\styles.json" `
  http://localhost:8787/users/test-user/upload
```

## API

- `GET /health`
- `GET /drive/check`
- `POST /users/:userId/upload`
- `GET /users/:userId/files`
- `GET /files/:fileId/download`
