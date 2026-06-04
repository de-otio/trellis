# Threat Model

## What This Addresses (Casual Discovery)

- A recruiter Googling the user
- An ex scrolling back through years of posts
- A journalist trawling public archives
- Search engine indexing of old content
- Wayback Machine / web archive captures

## What This Does NOT Address (Accepted Risks)

- **Screenshots and copy-paste** -- true of Snapchat too; users understand this intuitively
- **Server-side trust** -- the server stores content in plaintext; same trust model as every existing platform, but now with an off-switch
- **Legal holds** -- preservation orders prevent key deletion; this is a legal problem, not an engineering one
- **Malicious redistribution** -- someone screenshots and reposts; no cryptographic scheme solves this
- **Determined adversaries / nation-state actors** -- explicitly out of scope
