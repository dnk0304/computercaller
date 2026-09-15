/**
 * /extension metadata boundary (2026-09-15, forge/ext-badge-sidepanel, item 7).
 *
 * WHY THIS FILE EXISTS AT ALL
 * It renders nothing. Its only job is `metadata` — and that job is a rule, not
 * a preference: no price, no trial offer and no upgrade CTA ships on the
 * extension surface. Both /extension and /extension/login inherit the ROOT
 * layout's marketing metadata, whose description, og:description and
 * twitter:description all end "7-day free trial, then $5/month." Those strings
 * are correct on computercaller.com and wrong inside a Chrome popup: they are
 * rendered into the <head> of HTML that Chrome frames as part of the product.
 * Invisible to the eye, present in the DOM, and exactly the sort of thing that
 * turns up in a screenshot of View Source or a store review.
 *
 * ONE file rather than two overrides (the (surface) layout + login/page.tsx)
 * because login/page.tsx is a client component and cannot export metadata at
 * all, and because two copies of the same neutral sentence is one copy too many
 * — the day the wording changes, only one of them would.
 *
 * All three description fields are replaced. Overriding `description` alone
 * would leave the two Open Graph strings, which carry the same price text.
 *
 * A passthrough layout adds no element to the tree, so the (surface) layout's
 * height:100% / overflow:hidden column and the login route's own full-height
 * form are both untouched.
 */

import type { Metadata } from 'next';
import { THEME_BOOT_SCRIPT } from '@/lib/extensionTheme';

const EXTENSION_DESCRIPTION =
  'Call and text from your browser. Your phone does the calling; your computer does the typing.';

export const metadata: Metadata = {
  description: EXTENSION_DESCRIPTION,
  openGraph: { description: EXTENSION_DESCRIPTION },
  twitter: { description: EXTENSION_DESCRIPTION },
};

export default function ExtensionMetadataLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /*
   * ONE THING BESIDES METADATA (dispatch J addendum, 2026-09-15): the theme
   * boot script. extension.css no longer asks the OS whether to go dark — it
   * gates its whole remap on `data-cc-theme` on <html> — so something has to
   * stamp that attribute, and it has to happen during HTML parse. Anything
   * that waits for hydration paints a white panel first and corrects it a
   * frame later, on every popup open, for every dark-mode user.
   *
   * Here rather than in the root layout because it is an extension-surface
   * concern and this is the extension surface's boundary; here rather than in
   * (surface)/layout.tsx because /extension/login is NOT inside that route
   * group and needs the same theme.
   *
   * The passthrough note above still holds for layout purposes: a <script> is
   * display:none per the UA stylesheet, so the (surface) layout's height:100%
   * / overflow:hidden column is unaffected.
   */
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      {children}
    </>
  );
}
