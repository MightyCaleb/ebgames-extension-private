EB Games Auto Checkout v1.9.0 — Discord Notifications

DISCORD SETUP
1. In Discord, open your server settings, then Integrations > Webhooks.
2. Create a webhook for the channel where you want notifications and copy its URL.
3. Open the extension popup, paste the URL into Discord notifications, and click Save webhook.
4. Click Test notification and confirm it appears in the chosen channel.
5. Keep the webhook URL private. Do not commit it to GitHub or paste it into source files. The extension stores it in the current Chrome profile's local extension storage. Anyone with access to that browser profile or its extension storage may still be able to retrieve it.

NOTIFICATIONS
- A message is sent for each product-add result: confirmed or not confirmed.
- A summary is sent when cart quantity preparation finishes, including failures and elapsed time.
- This extension does not complete checkout or payment, so notifications do not claim that a purchase succeeded.

RELEASE / UPDATE FLOW
1. Commit the updated source files to the private GitHub repository.
2. Create a GitHub Release tagged v1.9.0.
3. Attach the packaged extension ZIP named exactly ebgames-extension.zip.
4. Run Run-EBGamesUpdater.bat. It downloads the latest release, backs up the configured unpacked extension folder, and installs the files.
5. Open chrome://extensions and click Reload for the existing unpacked extension.

Keep the repository private. The webhook URL is not included in this ZIP.
