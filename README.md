# EB Games Extension v1.9.8 — Add Product Button Fix

This is an unpublished test build based on the v1.9.6 draft.

## Changes
- Fixed popup initialization: removed a leftover event listener for the deleted test-template button that stopped the popup script before the Add product handler could register.
- Removed the “Load 3-product test template” button and its handler.
- Removed the “Retry cart quantities” button and its handler.
- Removed the cart script's manual retry message path; automatic sequential quantity continuation across cart refreshes remains.
- Kept the product list auto-save, parallel product tabs, Discord webhook settings, active-account detection, time field, and product notification details.

## Test
1. Extract this ZIP into a new folder.
2. Open `chrome://extensions`, enable Developer mode, and select **Load unpacked**.
3. Select this folder. Re-enter the Discord webhook URL if the new unpacked extension has separate storage.
4. Enter product URLs and quantities manually, then test.

Not published to GitHub. Checkout/payment remains manual.
