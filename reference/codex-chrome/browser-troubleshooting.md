# Browser Interaction Troubleshooting
- Do not inspect browser-use source code or switch to an unrelated control mechanism before using the selected browser's documented API.
- If the selected browser disconnects, obtain a fresh browser from `agent.browsers`, read its documentation again, and obtain fresh tabs. Do not reuse tabs, locators, or capabilities from the disconnected browser.
- If a documented API is unavailable on the selected browser, use the alternatives that its effective API and capabilities expose rather than guessing hidden methods.
