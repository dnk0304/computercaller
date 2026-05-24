# Whop product page — branding & content brief

> Ken-authored deck for Phase 9 of the deploy. The Whop product page at
> https://whop.com/computercaller/computercaller-82/ is the page that
> converts trial users into €7.99/month paying customers. It needs to
> feel like a continuation of computercaller.com, not a different app.

Last updated: 2026-05-24 (Ken dispatch #14).

---

## What Dennis edits in the Whop dashboard

Whop dashboard → Products → ComputerCaller → Edit. The fields below are
the ones that matter for brand consistency.

### Product name

`ComputerCaller`

(Drop the "computercaller-82" slug from anywhere user-visible. The slug
in the URL stays because changing it breaks existing checkout links.)

### Tagline / short description

> Use your Android phone's calls and messages from any browser.

(60 chars. Mirror of the Play Store short description so the brand voice
matches across surfaces.)

### Long description

```
ComputerCaller pairs your Android phone with your browser so you can
make calls, send messages, and see notifications without picking up
your phone.

Make calls from your computer. Read and reply to SMS and MMS without
leaving your keyboard. See incoming messaging-app notifications in real
time. Keep your phone in your pocket.

WHAT YOUR SUBSCRIPTION INCLUDES
• Full dashboard with calls, messages, and notifications
• Unlimited messages and call log entries
• Use it from any computer
• Priority email support

5-DAY FREE TRIAL
Start free, no credit card required. After the trial: €7.99 per month.
Cancel any time from your Whop account.

WORKS WITH
Android 8.0 or newer + any modern web browser (Chrome, Firefox, Safari,
Edge). Free Android app at computercaller.com after sign-up.

Questions? support@computercaller.com
```

---

## Visual assets

Use the same gradient lockup as the marketing landing for visual
continuity. Source files live in `public/brand/` of the web repo:

| Asset | Spec | Source |
|---|---|---|
| Product logo | 512x512 PNG, transparent background, the gradient logo lockup | derive from `public/brand/computercaller-banner-allBlack.png` (Pixel) |
| Cover image | 1280x640 PNG/JPEG, the gradient orb hero from the landing page | screenshot of `app/page.tsx` hero section, or the Pixel feature-graphic for Play |
| Gallery (3-5 images) | 1280x720 PNG, screenshots of the actual product | reuse from `public/brand/play-store/screenshots/` |

Pixel pipeline: create one source-of-truth Figma board, then export
per-spec for Play Store + Whop + landing meta-image. Don't have one
brand asset per surface — that's how the visual identity drifts.

---

## Pricing display

| Field | Value |
|---|---|
| Price | €7.99 / month |
| Billing cycle | Monthly |
| Trial length | 5 days |
| Trial requires credit card | No |
| Currency | EUR (primary). Whop auto-converts to local on display. |
| Tax handling | Whop handles VAT — leave on default. |

The 5-day trial matches the in-app trial set in `app/api/auth/register/route.ts`
(line 24, `5 * 24 * 60 * 60 * 1000`). If you change one, change the
other — they MUST stay in sync or users see a different trial length on
the product page vs. inside the product.

---

## Webhook configuration

Already configured by Dennis before deploy. For reference:

| Field | Value |
|---|---|
| Webhook URL | `https://computercaller.com/api/webhooks/whop` |
| Webhook secret | (in `agent-memory/niki/PROJECTS/computercaller/CREDS.md`) |
| Events subscribed | All (per Dennis's setup) |
| Signature verification | HMAC-SHA256 over raw body (implemented in `app/api/webhooks/whop/route.ts`) |

**Test after first deploy:** trigger a fake checkout in the Whop dashboard
sandbox, then check the production logs at Coolify for "[Whop webhook]
verified" — that proves signature verification passed end-to-end.

---

## Refund policy (paste into Whop refund settings)

```
14-day money-back guarantee on your first month. Email
support@computercaller.com with your account email and we will refund
the most recent payment, no questions asked.

After the 14-day window, refunds are at our discretion — we generally
refund prorated time for technical issues we cannot resolve.

Cancellation stops your next renewal immediately; you keep access until
the end of your paid period.
```

---

## Categories and tags on Whop

- **Category:** Productivity / Tools
- **Tags:** `productivity`, `phone`, `android`, `sms`, `messaging`,
  `remote-work`, `desktop-companion`

---

## What Dennis does today (Phase 9)

1. Whop dashboard → Products → ComputerCaller → Edit
2. Update tagline, long description, price display per above
3. Upload the gradient logo + cover image (Pixel hands these over)
4. Save, view the public product page in incognito
5. Confirm the page looks like a continuation of computercaller.com,
   not a generic Whop template
6. Test a checkout end-to-end with a real card → cancel → confirm
   webhook fired against prod

---

## File references

- Trial-length source: `app/api/auth/register/route.ts:24`
- Webhook handler: `app/api/webhooks/whop/route.ts` (HMAC verified)
- Public checkout URL env: `NEXT_PUBLIC_WHOP_CHECKOUT_URL` (set in Coolify)
- Brand source: `public/brand/computercaller-banner-allBlack.png`
