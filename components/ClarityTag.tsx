import Script from 'next/script';

/**
 * Microsoft Clarity — UNAUTHENTICATED MARKETING SURFACES ONLY.
 *
 * ⚠️ SECURITY / GDPR BOUNDARY — read before adding this anywhere.
 *
 * Clarity is a session-REPLAY product: it serialises the live DOM and ships it
 * to a third party (Microsoft). On any authenticated ComputerCaller surface the
 * DOM contains SMS bodies, contact names, phone numbers and notification text —
 * i.e. user content we have no lawful basis to hand to an analytics vendor.
 *
 * It used to live in the ROOT layout (app/layout.tsx), which meant it loaded on
 * /app/** too. From 2026-08-31 to 2026-09-16 the tag was inert because CSP
 * blocked it; commit 77a0136 added the CSP allow for the marketing pages and
 * thereby switched the leak ON for authed sessions. This component is the fix:
 * the tag is now opt-IN per route instead of site-wide opt-out.
 *
 * ALLOWED (content-free, logged-out marketing). Rendered from exactly ONE
 * place — app/(marketing)/layout.tsx — which covers the whole route group:
 *   /                 app/(marketing)/page.tsx
 *   /guides           app/(marketing)/guides/            (incl. /guides/[slug])
 *   /privacy          app/(marketing)/privacy/
 *   /terms            app/(marketing)/terms/
 *
 * `(marketing)` is a route group: the parentheses keep it out of the URL, so
 * none of these paths changed. A new page is OUTSIDE the group unless someone
 * deliberately puts it inside — analytics is opt-in by location.
 *
 * FORBIDDEN — never import this from, or from any layout above:
 *   /app/**        renders messages, contacts, call logs, notifications
 *   /messenger/**  renders a conversation thread
 *   /extension/**  renders the paired phone's data inside the extension
 *   /auth/**       carries email addresses and credential fields
 *   /subscribe     carries billing identity
 *   /app/admin/**  renders other users' account data
 *
 * Masking (data-clarity-mask / mask-all) is deliberately NOT used as a
 * substitute here: whether /app gets analytics at all is Dennis's call, and a
 * masking config is one vendor-side toggle away from leaking again. Default off.
 *
 * Enforced by scripts/check-clarity-scope.mjs, which greps the rendered HTML of
 * every route and fails the build if `clarity.ms` appears on a non-allowed one.
 *
 * The project ID is a public client-side identifier, not a secret.
 */
export default function ClarityTag() {
  return (
    <Script id="ms-clarity" strategy="afterInteractive">
      {`(function(c,l,a,r,i,t,y){
          c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
          t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
          y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
      })(window, document, "clarity", "script", "yaz1n9clas");`}
    </Script>
  );
}
