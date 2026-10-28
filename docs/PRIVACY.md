# MyHarness Privacy Policy

Effective date: 28 October 2026

MyHarness is an open-source AI agent that runs on your own computer. This policy explains what it does with your data,
in particular with data from your Google Account.

## Summary

- MyHarness has no server of its own. Data moves only between your computer and the services you connect yourself:
  Google, Microsoft, GitHub and the AI model providers you configure.
- The developer of MyHarness does not receive, collect or store your data, your sign-in tokens or your synced content,
  and has no access to them. The source build sends no telemetry.
- MyHarness does not sell your data, use it for advertising or use it to train AI models.

## Google Drive sync

Sync starts only when you press **Connect Google Drive** and sign in. MyHarness asks Google for:

| Permission | Why |
| --- | --- |
| `openid`, `email`, `profile` | To show which Google account is connected and to keep two accounts apart. |
| `https://www.googleapis.com/auth/drive.file` | To create and update the `MyHarness` folder in your Drive. This permission covers only the files MyHarness created or that you opened with it; MyHarness cannot see the rest of your Drive. |

The `MyHarness` folder holds your MyHarness data so that your computers can share it: chats, memories, attachments,
generated files, drafts, prompts, and the built-in browser's bookmarks, shortcuts and site settings. The browser's
sign-ins and saved passwords are uploaded only if you set a sync passphrase, and only after they were encrypted with it
on your computer. A workspace's files are uploaded only if you turn that on for the workspace. API keys and sign-in
tokens are never uploaded.

## Mailboxes (Gmail and Outlook)

If you connect a mailbox, MyHarness asks for access to read, search, send and organize your mail (Gmail:
`https://mail.google.com/`; Outlook: Microsoft Graph `Mail.ReadWrite`, `Mail.Send` and `MailboxSettings.ReadWrite`). The
agent uses this access only for what you ask it to do in a conversation. Mail it reads becomes part of that conversation
(see "AI model providers").

## Sign-in tokens

The tokens Google, Microsoft or GitHub issue to MyHarness are stored only in files on your computer, in the MyHarness
settings folder. They are not uploaded, not synced and not shared.

## AI model providers

What you put into a conversation, including content the agent reads for you (for example a mail or a file), is sent to
the AI model provider you configured so that it can answer. That provider's own terms and privacy policy apply. Sync
itself sends nothing to model providers.

## Google API Services User Data Policy

MyHarness's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the
Limited Use requirements.

## Your choices

- **Disconnect** in MyHarness removes the tokens from your computer.
- You can remove MyHarness's access at any time on your Google Account's
  [third-party connections page](https://myaccount.google.com/connections).
- To delete synced data, delete the `MyHarness` folder in your Google Drive. The data on your computers stays until you
  delete it there.

## Changes

Changes to this policy are published at this address; the repository history keeps every earlier version.

## Contact

Questions about this policy: open an issue at https://github.com/h3327725338-star/MyHarness/issues.
