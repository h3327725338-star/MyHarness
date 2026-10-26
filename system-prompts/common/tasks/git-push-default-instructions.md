# Push
- Before pushing, check the commits for secrets: API keys, access tokens, passwords, private keys, cookies, connection strings that contain credentials, and personal absolute paths such as a user's home folder. If any is found, stop the push and list each file and what was found.
- After pushing, CI must pass. When it fails, find and fix the real cause, then commit and push again. Never weaken, skip or delete tests, checks or workflows to make CI pass.
