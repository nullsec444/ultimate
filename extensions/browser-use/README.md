Carry out multi-step goals on the live web in a real headless browser, powered by the local
`browser-use` service (systemd `browser-use.service`) driven by deepseek over CommandCode.

The `browser_use` tool takes a plain-language task and navigates, clicks and reads on its own,
then reports the result. One run at a time; set `BROWSER_USE_URL` to point at another service.
