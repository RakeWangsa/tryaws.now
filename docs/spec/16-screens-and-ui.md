<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 1132-1497. Change the plan, then run pnpm spec:split. -->

## 16. Screens and UI

Priority column in this section: P0 is needed on launch day (core gate). P1 opens with its launch gate (A or B) or during launch week. P2 comes after launch.

### 16.1 What the mockup is

The mockup zip received on 2026-11-10 is the unmodified ThemeForest item "Antler - Hosting Provider & WHMCS Template", version 4.5.0, by inebur. Keep its contents in the private repo under `design/mockup/` as a read-only reference. Nothing is imported from that folder directly; `scripts/sync-theme.ts` copies the shipped files (16.3).

| Folder in the zip | Contents | Use |
| --- | --- | --- |
| `template/` | 57 static HTML pages of a hosting company website and `assets/` (Bootstrap 5.2.3, theme CSS, jQuery 3.7.1 with plugins, icon fonts, patterns, images) | The look of the product and the layouts named in 16.6 to 16.12 |
| `order-form/antler/` | 26 Smarty `.tpl` files, a skin for the WHMCS `standard_cart` order form | Reference for order states and wording. Not code for this product |
| `email/` | One HTML email layout: `index.html`, `header.html`, `footer.html`, `global.css` | Layout of transactional emails (16.14) |
| `newsletter/` | A newsletter layout | Not used at launch |
| `graphic/` | Four Illustrator files with the Antler logo and artwork | Not used. The TiCON Cloud logo comes from the `ticoncloud` site repo |
| `documentation/` | The theme's own documentation | Reference |

Facts that shape this section:

- Nothing in the zip is customized. Titles, logo, text, USD prices and form targets are the theme's demo content. The mockup defines how the product looks, not what its screens contain.
- The zip has no customer panel. The theme's WHMCS client area (the `whmcs-template` folder named in the theme documentation) is not in the zip, and no page shows a dashboard, wallet, server management, KYC, invoice or admin screen. Sections 16.9 to 16.12 specify those screens and compose them from the theme's own blocks.
- With no saved settings the pages render with `data-layout="wide"`, `data-color="pink"`, `data-background="dark"`, `data-font="opensans"`, `data-header="static"`, `data-radius="defaultradius"` and `data-textdirection="ltr"` on `<body>` (checked by loading the pages in a browser). The values in `assets/js/settings-init.js` are not applied while its settings panel is switched on. The theme also has the color schemes `blue`, `green` and `black` and the backgrounds `light`, `origin` and `modern`. Each is one attribute.
- The shipped CSS has no external URL and no `@import`. The request to Google Fonts is made only by the theme's JavaScript, which is not shipped.
- Licence: an Envato licence covers one end product, which for a site theme is one customized website. Under Envato's licence FAQ a Regular License is enough while visitors can use the site without paying for access to it, and payment for a separate product or service does not require the Extended License. This is a reading of the FAQ, not legal advice. Before launch confirm that the licence used here is not already used on another site (Section 17).

### 16.2 UI rules

These go verbatim into `.claude/rules/ui.md` (Appendix R). `CLAUDE.md` carries a one-paragraph summary.

| # | Rule |
| --- | --- |
| U1 | The mockup is the look. Reuse its CSS classes and layouts; do not redesign. Where a screen has no mockup page, compose it from the kit in 16.6 and the shells in 16.7. |
| U2 | Ship CSS, fonts and images only. No file from the theme's `assets/js`, `assets/php` or `order-form/` reaches a build: no jQuery, no plugin, no `scripts.js`, no `settings-init.js`, no i18next, no cookie plugin, no Smarty. |
| U3 | No third-party origin at runtime. Fonts, styles, icons and images are self-hosted. No analytics, chat or tag script without a recorded decision and a CSP entry. |
| U4 | No inline script except the nonce scripts of Next.js. No inline `style` attribute in server-rendered markup; use classes. CSP runs in report-only mode on staging and a screen is done only at zero violations. |
| U5 | All text comes from `next-intl` messages in `bn` and `en`. No hard-coded strings in components. Bengali is written first. |
| U6 | AWS is named openly. Public pages, the panel, invoices and emails tell the customer that the service is 100% AWS: every resource is an Amazon Lightsail resource in an AWS Region. Use the statements, names and wording rules of 16.13, which follow the AWS Trademark Guidelines. Still never shown to a customer: AWS account ids, ARNs, the pool account structure, internal AWS resource names and raw AWS error text. Errors from AWS are mapped to platform messages. |
| U7 | Server Components by default. A component is a Client Component only when it holds interaction state. Data is read on the server through repositories (R8). No customer data in `localStorage` or `sessionStorage`. |
| U8 | Every form posts to a Server Action that follows R9, and shows field errors from the same zod schema. A button that changes state is disabled while its action is pending, and the action is idempotent (R7). |
| U9 | A secret shown to a customer (Windows password, database password, bucket secret key) is returned once in a Server Action response with `no-store`, is never part of a cached render, is never logged, and is hidden again after 60 seconds. |
| U10 | A destructive action needs a dialog in which the customer types the resource name, and a fresh sign-in (Section 6.1). |
| U11 | Every screen has loading, empty, error and flag-off states (16.13) and works at a width of 360 px. State is never shown by color alone. |
| U12 | A redirect target taken from a request (`next`) must be a relative path that matches an allow-list of route prefixes. |
| U13 | The theme's demo photos, avatars, partner logos, case study PDFs and videos are not shipped. |

### 16.3 Theme port

`scripts/sync-theme.ts` copies the files below from `design/mockup/template/assets/` to `packages/ui/theme/assets/`, and from there into `public/theme/assets/` of both apps. The `assets/` tree is mirrored because `theme.min.css` refers to its files with paths such as `../patterns/` and `../../assets/img/`. The root layout links the stylesheets with plain `<link rel="stylesheet">` tags in the order of the mockup's `<head>`: Font Awesome, icon fonts, Bootstrap, theme, and then `tc.css`. The script also copies `tc.css` to `public/theme/`, so it is linked last as a static file and the order is fixed.

| Shipped | Note |
| --- | --- |
| `css/bootstrap.min.css` | Bootstrap 5.2.3, CSS only |
| `css/theme.min.css` | Unmodified, so a theme update is a file swap. All product CSS goes into `packages/ui/styles/tc.css` |
| The 8 `patterns/*.svg` files that the theme CSS refers to | Background line patterns |
| `fonts/fonts.min.css`, `fonts/cloudicon/*`, `fonts/evafeat/*` | Line icon fonts used by plan cards and menus (`icon-*` classes) |
| `fonts/fontawesome/css/all.min.css`, `fonts/fontawesome/webfonts/*.woff2` | Font Awesome Free 6.4.2 |
| `apps/*.svg` (26 files) | Logos for image tiles, among them Ubuntu, Debian, CentOS, FreeBSD, Windows, WordPress, LAMP, Joomla, Magento, Drupal, GitLab, PrestaShop, Plesk and cPanel. An image without a logo uses a generic icon |
| The `fonts/svg/*.svg` files a component uses (the folder holds 306 line illustrations) | Imported as inline SVG at build time (16.5) |

| Never shipped | Why |
| --- | --- |
| `js/*`, `php/*`, and the whole `order-form/` folder | Rule U2 |
| `css/vendors.min.css`, `css/aos.min.css`, `css/rtl/*` | Styles of plugins and animations that are not used. The RTL files come back only when a right-to-left market opens |
| `img/topbanner*.jpg`, `img/partners/*`, `img/avatars/*`, `img/blog/*`, `casestudy/*`, `videos/*` | Demo photos, logos of other companies, PDFs and videos (rule U13). The CSS classes that refer to them are not used |
| `img/logo.svg`, `img/logo-light.svg`, `img/symbol.svg`, `img/favicon.ico` | Antler branding. Replaced by TiCON Cloud files in the same roles |
| `locales/*` | Theme demo translations. Text comes from `next-intl` |

The script copies only the allow-list above. It reports every `url()` in a shipped stylesheet that points to a file that is neither shipped nor on the never-shipped list, so a theme update cannot add a silent dependency. Four referenced files are already missing in the zip and belong to unused classes: `img/arrow-right-2.png`, `img/arrow-left-2.png`, `img/arrow-left-2-act.png` and `fonts/evafeat/evafeat.svg`.

### 16.4 Tokens and typography

| Token | Value | Note |
| --- | --- | --- |
| Theme attributes, customer app | `data-layout="wide" data-color="pink" data-background="dark" data-font="opensans" data-header="static" data-radius="defaultradius" data-textdirection="ltr"` on `<body>` | What the mockup renders. Written by the root layout from one config object. No cookie, no script |
| Theme attributes, admin app | The same with `data-color="blue"` and `data-background="light"`, and a fixed "OPS" label in the top bar | Staff must never mistake the admin panel for the customer panel |
| Colors on the dark background | Page `#15212a`, card `#101920`, text `#ffffff`, muted text `#6c757d` | Computed from the rendered mockup. Components use the helper classes `bg-colorstyle` (page sections), `bg-seccolorstyle` (cards), `mergecolor` and `seccolor` (text), not hex values |
| Colors on the light background | Page `#ffffff`, card `#ebeff5`, text `#212122` | Same classes |
| Accent | Pink `#ee5586`. Magenta `#a5215e` for plan specification blocks and badges (`bg-purple`) | |
| Buttons | Primary: yellow `#fdd700` with black text, pill shape (`btn btn-default-yellow-fill`), one per view. Secondary: `btn btn-default-pink-fill`. Tertiary: `btn btn-outline-pink`. Destructive: Bootstrap `btn btn-danger` | |
| Radius | Cards 15 px; buttons and inputs are pills | From `defaultradius` |
| Other color schemes | `data-color="blue"`, `"green"` or `"black"` change the accent with one attribute. For TiCON Cloud brand colors add `data-color="ticon"` by copying the `[data-color="pink"]` rules of `theme.css` (about 89 selectors) into `tc.css` with the brand values | Decision in Section 17. Never edit `theme.min.css` |
| Light and dark switch | Optional, P2: a customer setting that flips `data-background` between `dark` and `light`, stored in a cookie that the server reads | Both backgrounds already work in the theme |
| Font | The theme's rules name `'Open Sans'` with `!important`. Define that family in `tc.css` from self-hosted files: Open Sans for Latin text, and a second `@font-face` with the same family name and the Bengali `unicode-range` that points to Noto Sans Bengali. Take the files and the `unicode-range` values from the Fontsource packages (`@fontsource-variable/open-sans`, `@fontsource-variable/noto-sans-bengali`; confirm the names at install) | Open Sans has no Bengali glyphs. One composite family means no theme rule needs an override |
| Bengali text | For `html[lang="bn"]`: body line height of at least 1.6, `letter-spacing: 0`, no `text-transform`, headings one step smaller where a title wraps to three lines at 360 px | VERIFY that conjuncts and the taka sign render correctly on Android Chrome and iOS Safari |
| Icons | Font Awesome Free 6.4.2 (`fas`, `far`, `fab`), the theme's `icon-*` line icons, inline SVG illustrations | Decorative icons carry `aria-hidden="true"` |
| Breakpoints | Bootstrap 5 defaults. Design each screen at 360 px first | Most customers will use a phone |

### 16.5 Behavior that the theme does with scripts

| In the mockup | How the theme does it | In this product |
| --- | --- | --- |
| Header and footer | `header.html` and `footer.html` are loaded with jQuery | Shell components (16.7) |
| Theme settings panel | `settings-init.js`, cookies, `section#settings` | Fixed attributes on `<body>` (16.4). The panel and its cookies do not exist |
| Loading overlay | `div#spinner-area`, hidden by script | Not rendered |
| Deferred blocks | `div.lazyload` keeps its content inside an HTML comment until a plugin reveals it | Render the content directly |
| Illustrations | `img.svg` files are fetched and replaced by inline `<svg>` so CSS can color them | Import each SVG as a React component at build time and keep its class names and ids |
| Translations | i18next with files in `assets/locales` | `next-intl` |
| Tabs | Script on `.tabs-header` and `.tabs-item` | `Tabs` component that sets the `active` class |
| Accordion | Script on `.accordion .panel-title` | `Accordion` component with the same classes |
| Dropdown, modal, offcanvas | Bootstrap JavaScript | Radix primitives with the Bootstrap classes; focus trap and the Escape key work |
| Plan slider | noUiSlider with five plans written inside `scripts.js` (`VPS1` to `VPS5`) | `PlanPicker` fed by the catalog (16.6) |
| Monthly and yearly switch | `#run-switch` | Not used. Every term is 30 days |
| Filters on domain and price lists | Client-side filter plugins | React state over data from the server |
| Carousels | Slick and Swiper | A static grid, or a CSS scroll-snap row on phones |
| Scroll animations | AOS | None. Do not copy `data-aos` attributes |
| Forms | Posts to the theme author's WHMCS demo and to `assets/php/form-process.php` | Server Actions (rule U8) |
| Cookie banner | `gdpr-cookie.min.js` | None at launch. Only the cookies needed for sign-in and locale are set, and the privacy page says so |
| Fonts | A Google Fonts link injected by script | Self-hosted (16.4) |

### 16.6 Component kit in `packages/ui`

| Component | Built from | Notes |
| --- | --- | --- |
| `Card` | `div.sec-main.sec-bg1.bg-seccolorstyle.noshadow` in `checkout.html` and `login.html` | Base surface for panel content |
| `StatTile` | `about.html`, `section#clientstats`: `div.wrapper.price-container` | Dashboard numbers |
| `PlanCard` | `index.html`, `section.pricing`: `div.wrapper` with `div.top-content` and `ul.list-info.bg-purple`; tag `div.plans.badge.feat` | Name, price per 30 days, four specification lines, one button |
| `PlanPicker` | `vps.html`, `section#custom`: `div.wpc-cloud-range` and `div.content-price` | Phones: a list of radio cards. Desktop: the slider look on a native range input. Plans, specifications and prices come from the catalog; nothing is hard-coded |
| `OptionGroup` | `configurator.html`: `div.cd-filter-block` with `ul.radios-filter.cd-filter-content`, and the `select-filter` variant | Radio, checkbox and select groups |
| `ImageTile` | `header.html`: `div.os` tiles; logos from `/theme/assets/apps/` | Operating system and application choice |
| `SummarySidebar` | `configurator.html` and `cart.html`: `aside#sidebar.sidebar` with "Selected Plan" and `div.ordersummary` | Live price summary. On phones it becomes a bar fixed to the bottom of the screen |
| `PriceBreakdown` | `cart.html` and `checkout.html`: `table.table.compare.min` | AWS service price, one line per pricing step, total. Rendered on the server from an order or a draft |
| `DataTable` | `cart.html`: `table.table.compare` inside `div.table-responsive-lg` | Under 768 px each row becomes a stacked card. Cursor paging |
| `Tabs` | `checkout.html` and `login.html`: `div.tabs-header` with `li.btn.btn-secondary`, and `div.tabs-item` | |
| `Accordion` | `elements.html`, `section#addons`: `div.accordion.faq` | FAQ and help |
| `Field` | `elements.html`, block "Form Inputs" | Label, pill input, hint, and error text tied to the input with `aria-describedby` |
| `Badge` | `.badge` with Bootstrap background classes | State mapping in 16.13 |
| `Button` | `elements.html`, block "Buttons" | Variants in 16.4; pending state |
| `Modal`, `ConfirmDestroy`, `Toast` | The Bootstrap modal markup of `cart.html`; Bootstrap toast | `ConfirmDestroy` asks the customer to type the resource name |
| `EmptyState`, `ErrorPage` | `404.html`: `section.sec-normal.notfound`; `soon.html` | One sentence and one action |
| `HelpStrip` | `index.html`: `div.help-container` with `a.help-item` | Support entry points under public pages |
| `SecretReveal`, `CopyField` | `Field` with buttons | Rule U9 |
| `StatusTimeline` | `Card` with a step list | Order and operation progress |
| `MoneyText`, `DateText` | None | The only places that format money and dates (16.13) |
| `LocaleSwitch`, `WalletChip` | `header.html`: the `section#drop-lng` pills and the yellow "CLIENT AREA" button | |

### 16.7 Shells

| Shell | Built from | Content |
| --- | --- | --- |
| `PublicShell` | `header.html`: `div.infonews` (top line), `div.menu-wrap` with `nav#menu` (main bar), `div.menu-wrap.mobile`. `footer.html`: `footer.footer` | Top line: one announcement and the support phone. Menu: Products (the open product families), Pricing, Domains (when Gate B is open), Help, language switch with two entries (Bengali and English), and a yellow button that says "Log in", or "Console" for a signed-in visitor. Footer: four link columns (Products, Company, Support, Legal), company name and address from Section 1, the EPS footer banner from the `eps-payment-gateway` skill assets, and the AWS statement with the trademark line of 16.13. Not used: the "Special Deals" offcanvas, the cart and bell icons, the four-language switch, the newsletter form |
| `AuthShell` | `login.html`: `section.fullrock-content` | Logo and one full-height card with two tabs |
| `AppShell` | No mockup page shows an app frame, so it is composed. Top bar: the `div.menu-wrap` bar without the top line. Left navigation: `aside#sidebar.sidebar.sec-bg1.bg-seccolorstyle` of `legal.html` (icon and label rows, the active row in the accent color). Content column: `div#sidebar_content` of the same page with `Card` blocks | Top bar: logo, language switch, `WalletChip` with the balance and a yellow "Top up" button, notification bell, account menu. Navigation: Dashboard, Cloud Servers, Databases, Object Storage, Load Balancers, Containers, CDN, Domains and DNS, Wallet, Invoices, Support, Settings. A family whose flag is off is hidden, or shown with a "soon" tag when the market config asks for it. No pink title band inside the panel: each screen starts with a compact row of breadcrumb, title and one primary button. Under 992 px the navigation moves into the offcanvas of `header.html` (`div#offcanvasWithBackdrop`). A slim footer carries the short AWS statement and the trademark line of 16.13 |
| `AdminShell` | `AppShell` with the admin attributes of 16.4 | Navigation from 16.12, the "OPS" label, the signed-in admin and role |

Locale routing in both apps: `bn` at the root, `en` under `/en` (`next-intl`, prefix as needed). After sign-in the customer's saved locale decides.

### 16.8 Public pages

All are Server Components, indexable, with a canonical URL, `hreflang` for `bn` and `en`, structured data (`Organization`, `Product` with `Offer` in BDT, `FAQPage`, `BreadcrumbList`), `sitemap.xml` and `robots.txt`. Every price comes from `catalog_products` through the pricing engine. Plan cards and price tables show whole taka rounded up, with the note that prices include VAT and fees and are for 30 days. Each public page names the AWS service in its title, description and first paragraph in the form of 16.13 (for example "Cloud Server, built on Amazon Lightsail"), because customers look for AWS by name.

| Route | Mockup page | Content | P |
| --- | --- | --- | --- |
| `/` | `index.html` | Hero (`section.top-header`) with the AWS statement of 16.13, three `PlanCard` blocks fed by the catalog (cheapest open plan of three families), "Why TiCON Cloud" tiles (`section.services`), `HelpStrip`. Not used: the case study block and the map of seven datacenters (state the two launch locations as text) | P0 |
| `/pricing` | `pricing.html` | One tab per open family; plan boxes and the comparison table (`table.table.compare`). Not used: carousel and slider demos | P0 |
| `/products/cloud-servers` | `vps.html` | Plan cards, feature blocks (`section#features`), `PlanPicker` (`section#custom`), specification table (`section#specs`), FAQ | P0 |
| `/products/databases` | `database.html` | Tabs for MySQL and PostgreSQL with comparison tables | P1, Gate A |
| `/products/object-storage`, `/products/load-balancers`, `/products/containers`, `/products/cdn`, `/products/dns` | Layout of `vps.html` | The same blocks with the family's data | P1, with the family's gate |
| `/products/domains` | `domains.html` | Search box (`section.cd-main-content`, `div.cd-filter`), TLD table (`table.table.compare`: register, renew, transfer) from `tlds` with a text filter, FAQ. The availability check goes through `reader`, is cached for 60 seconds, and has a WAF rate rule and an application limit per IP | P1, Gate B |
| `/payments` | `payments.html` | How top-up works, payment methods with the EPS banner, link to the refund policy | P1 |
| `/help` | `faq.html` | FAQ in an `Accordion` from MDX files in the repo, at least ten questions at launch. Required questions: is this real AWS (yes, 100%), do I get an AWS account or the AWS console (no, the TiCON Cloud panel), who bills and supports me (TiCON Cloud), where is my data (the AWS Region the customer chose) | P0 |
| `/help/[slug]` | `knowledgebase-list.html`, `knowledgebase-article.html` | Help articles from MDX files | P2 |
| `/support` | `contact.html`, `section#ticket` | Form: name, email, subject, department, message, saved in `support_requests` and mailed to the support inbox. Rate limited per IP, with a hidden honeypot field (no third-party captcha, rule U3). Phone and the company address. Not used: the map and the newsletter checkbox | P0 |
| `/legal/[doc]` | `legal.html` | Sidebar of documents and versioned content from MDX: terms, acceptable use, privacy, refund, domain registration agreement | P0 |
| Not found, error, maintenance, coming soon | `404.html`, `maintenance.html`, `soon.html` | `not-found` and `error` files of Next.js, a maintenance page behind one switch, and the page of a flag-off family with a "notify me" button that writes `waitlist_entries` | P0 |

### 16.9 Sign-in and onboarding (WP2)

| Route | Built from | Fields and behavior | Actions | P |
| --- | --- | --- | --- | --- |
| `/signup` | `login.html`, tab "Create a New Account" | Full name, email, mobile number (normalized to `+880`), password (at least 12 characters), account type; a business adds the company name. Three consent boxes (terms, acceptable use, privacy) saved in `legal_acceptances`. Not taken from the mockup form: address lines, state, postcode, country, security question | `signUp` | P0 |
| `/verify` | Same card | Email code, then phone OTP with a resend timer and the limits of Section 6.1 | `confirmEmail`, `sendPhoneOtp`, `verifyPhoneOtp` | P0 |
| `/login` | `login.html`, tab "Already Registered?" | Email and password, then the TOTP step when enabled. No "remember me". One generic message for a wrong email or password | `signIn`, `signOut` | P0 |
| `/forgot-password`, `/reset-password` | Same card | Cognito reset flow. The answer is the same whether the email exists or not | `requestPasswordReset`, `resetPassword` | P0 |
| `/kyc` | `OptionGroup` and `Field` blocks of `configurator.html` inside `AppShell` | Steps: account type, identity details, document upload (presigned POST; size and type are checked in the browser and enforced by the upload policy), review. Then a status view for `pending`, `verified` and `rejected` with the reviewer's note | `startKycUpload`, `submitKyc` | P0 |

### 16.10 Customer panel

All routes use `AppShell`, send `X-Robots-Tag: noindex`, and read data through repositories scoped to the signed-in customer (R8). "Review" in the Actions column means the action creates an order draft and continues in the flow of 16.11.

| Route | Built from | Shows | Actions | WP | P |
| --- | --- | --- | --- | --- | --- |
| `/dashboard` | `StatTile` row, `DataTable` | Wallet balance, active resources per family, renewals due in 7 days with amounts, alerts (KYC pending, low balance, resources in grace), the last five operations. Empty state: a checklist (verify phone, complete KYC, top up, create the first server) | None | WP3, completed in WP5 | P0 |
| `/wallet` | `DataTable`, `StatTile` | Balance; ledger lines (date, description, money in or out, running balance); payments with their state | `exportStatementCsv` (P2) | WP3 | P0 |
| `/wallet/topup` | The card of `checkout.html` without its account tabs; `OptionGroup` for quick amounts | Amount field with quick amounts and the market's minimum and maximum, the EPS banner, pending payments | `startTopUp`, then the browser goes to EPS | WP3 | P0 |
| `/wallet/topup/[paymentId]` | `EmptyState` style card. Wording reference: `complete.tpl` and `error.tpl` in `order-form/antler/` | Only the verified state: success with the new balance, pending with automatic refresh, failed, cancelled, expired | `recheckPayment` (rate limited) | WP3 | P0 |
| `/invoices`, `/invoices/[id]` | `DataTable`; `PriceBreakdown` | Invoice list. One invoice: AWS service price line, one line per pricing step, total, company address, customer details, and a PDF link that is a short-lived presigned URL issued after a tenant check | `getInvoicePdfUrl` | WP3 | P0 |
| `/orders/review` | `cart.html` ("Review & Checkout"): `table.table.compare` and `aside#sidebar.sidebar` "Order Summary" | The draft: product, options, 30-day term, price lines, total, wallet balance after purchase, terms box. When the balance is short: the shortfall and a top-up button that returns here | `placeOrder` | WP4 | P0 |
| `/orders/[id]` | `StatusTimeline` | Order lines, payment, progress (paid, creating, ready), or the failure with its automatic refund line | None | WP4 | P0 |
| `/servers` | `DataTable`, `EmptyState` | Name, image logo, plan, location, public IP, state badge, period end, automatic renewal | `setAutoRenew` | WP4 | P0 |
| `/servers/new` | `configurator.html`, `section.config`: option groups on the left, `SummarySidebar` on the right | One page with steps: location (the AWS Region with its name and code), image (tabs for operating systems and applications, `ImageTile`), plan (`PlanPicker`), SSH key, options (automatic backups, label). The price in the sidebar comes from the server on every change | `createOrderDraft` (review) | WP4 | P0 |
| `/servers/[id]` | `Tabs` in a `Card`, tabs below | Header: label, state, addresses, plan, AWS Region and Availability Zone, period end | | WP4 | P0 |
| Tab Overview | `StatTile`, `CopyField` | Specifications, addresses, renewal date, data transfer used against the allowance | `rebootServer`, `stopServer`, `startServer`, `renameServer` | WP5 | P0 |
| Tab Access | `CopyField`, `SecretReveal` | SSH command and key name. Windows: user name and the password on demand through `access-details` | `revealWindowsPassword` | WP4; Windows in WP6 | P0; Windows P1 |
| Tab Networking | `DataTable` with inline editing | Firewall rules (protocol, port range, source CIDR) and the static IP | `saveFirewallRules`, `attachStaticIp`, `detachStaticIp` | WP4 | P0 |
| Tab Backups | `DataTable` | Backups with size and date, the automatic backup switch and hour | `createBackup`, `deleteBackup`, `setAutoBackup`, `restoreToNewServer` (review) | WP5 | P0 |
| Tab Storage | `DataTable` | Attached disks with size and path | `addDisk` (review), `attachDisk`, `detachDisk`, `destroyDisk` | WP5 | P0 |
| Tab Metrics | Charts | CPU, network in and out, status checks for 1 hour, 1 day and 1 week, read through `reader` | None | WP5 | P0 |
| Tab Billing | `PriceBreakdown` | Plan, current period, next renewal amount, automatic renewal, past invoices | `setAutoRenew`, `renewNow` (review) | WP5 | P0 |
| Tab Destroy | `ConfirmDestroy` | What is deleted, what is kept, and for how long | `destroyServer` (rule U10; enters the approval queue until 2026-12-01) | WP5 | P0 |
| `/databases`, `/databases/new`, `/databases/[id]` | The list, configure and tab patterns above; plan table from `database.html` | Engine and version, plan, location. Detail: endpoint, port, user, password on demand, public mode switch with a warning, backups, metrics | `createOrderDraft` (review), `revealDatabasePassword`, `setPublicMode`, `createBackup`, `destroyDatabase` | WP6 | P1, Gate A |
| `/storage`, `/storage/new`, `/storage/[id]` | Same patterns | Plan, usage, access mode, access keys (the secret is shown once) | `createOrderDraft` (review), `createAccessKey`, `deleteAccessKey`, `setBucketAccess`, `destroyBucket` | WP6 | P1, Gate A |
| `/load-balancers`, `/load-balancers/new`, `/load-balancers/[id]` | Same patterns | Targets (the customer's own servers in the same location), health, HTTPS certificate state | `createOrderDraft` (review), `setTargets`, `requestCertificate`, `destroyLoadBalancer` | WP6 | P1, Gate A |
| `/containers`, `/containers/new`, `/containers/[id]` | Same patterns | Power and scale, public image and ports, deployment state, public URL | `createOrderDraft` (review), `deployContainers`, `destroyContainerService` | WP7 | P1, Gate B |
| `/cdn`, `/cdn/new`, `/cdn/[id]` | Same patterns | Origin (own server, load balancer or bucket), state, default domain | `createOrderDraft` (review), `setCdnEnabled`, `destroyCdn` | WP7 | P1, Gate B |
| `/dns`, `/dns/[zone]` | `DataTable` with inline editing | Zones, name servers, delegation state, records | `createOrderDraft` (review), `saveRecord`, `deleteRecord`, `destroyZone` | WP7 | P1, Gate B |
| `/domains`, `/domains/new`, `/domains/[name]` | Search and TLD table of `domains.html`. Wording reference: `domainregister.tpl` and `configuredomains.tpl` | Search, price per year, registrant contact form, a second confirmation that repeats the domain name. Detail: state, expiry, contact verification state, name servers | `checkDomain`, `createOrderDraft` (review), `resendVerificationEmail`, `renewDomain` (review), `setNameServers` | WP7 | P1, Gate B |
| `/settings/profile` | `Field` forms in a `Card` | Name, company, billing address, locale | `updateProfile`; `changeEmail` and `changePhone` need a fresh sign-in and a new verification | WP2 | P0 |
| `/settings/security` | Same | Password change, TOTP setup with a QR code, sign out of other sessions | `changePassword`, `enableTotp`, `disableTotp`, `signOutEverywhere` | WP2 | P0 |
| `/settings/ssh-keys` | `DataTable`, `Modal` | Public keys with fingerprints. Add by paste, or generate in the browser with Web Crypto: the private key is offered as a download and never reaches the server | `addSshKey`, `deleteSshKey` | WP4 | P0 |
| `/notifications` | `DataTable` | The last 50 notifications; the bell in the top bar shows the unread count | `markNotificationsRead` | WP5 | P1 |
| `/support` when signed in | `contact.html`, `section#ticket` | Request form with category and related resource; the customer's earlier requests | `createSupportRequest` | WP9 | P0 |

### 16.11 Create and pay flow

There is no multi-item cart at launch: one resource per order, paid from the wallet. From `cart.html` and `checkout.html` the layout is used; the payment method select, the promo code field and the order notes are not.

1. Configure (`/servers/new` or another family's `/new` page). The page loads the catalog rows that the customer may buy (feature flags, risk tier limits of Section 10.2, allowed locations). The client never computes money.
2. `createOrderDraft` validates the configuration (zod, limits, flag, KYC `verified`, capacity available but not yet reserved), prices it, and returns a draft token: the customer id, the configuration, the price snapshot and the rule version, signed with a server secret (HMAC), valid for 30 minutes. The token holds nothing secret and is accepted only from the customer it names. No database row is written.
3. Review (`/orders/review?d=<token>`) shows the lines, the total, the balance after purchase, the 30-day term, the renewal rule and the terms box.
4. Short balance: the page shows the shortfall and a button to `/wallet/topup` with the amount pre-filled and `next` set to the review URL (rule U12). After a verified top-up the customer is back on the review page. Nothing is bought automatically.
5. `placeOrder` takes the token and an idempotency key, verifies the signature and expiry, and prices again. If the total differs from the token (the FX rate or a rule changed), it returns the new price and asks again. Otherwise it runs the purchase transaction of Section 3.4 and redirects to `/orders/[id]`.
6. `/orders/[id]` refreshes every few seconds until the operation is `succeeded` or `failed`, then links to the resource. A failed create shows the automatic refund line from the ledger.
7. When the home pool is full, review offers the waitlist (`waitlist_entries`). The order is never placed elsewhere silently (Section 10.2).

### 16.12 Admin screens (WP8)

All use `AdminShell` and the same kit. Every action stores actor, reason, IP and target (R10).

| Route | Shows | Actions | Roles | P |
| --- | --- | --- | --- | --- |
| `/login` | Sign-in with TOTP, always | `signIn` | All | P0 |
| `/` | Today: verified top-ups, orders, active resources, operations waiting for approval or attention, dead-letter count, capacity warnings, KYC waiting | None | All | P0 |
| `/customers`, `/customers/[id]` | Search. Profile, KYC submissions with a document viewer (images through short-lived presigned URLs, never cached), risk tier, limits, resources, wallet summary, audit trail | `approveKyc`, `rejectKyc`, `setRiskTier`, `setLimits`, `suspendCustomer`, `resumeCustomer` | `support` reads; `ops` acts | P0 |
| `/wallets/[customerId]` | Ledger | `createAdjustment` with a reason and a second approval above the limit | `finance` | P0 |
| `/payments` | Search by transaction id; state and verify payload | `reverifyPayment`, `recordManualRefund` | `finance` | P0 |
| `/pricing` | FX rate history, pricing steps per market, config prices | `setFxRate`, `savePricingRule` (preview of five products before saving) | `finance`, `superadmin` | P0 |
| `/catalog` | Products with their flags, image allow-list, last sync | `setFeatureFlag`, `setImageAllowed`, `runCatalogSync` | `ops` | P0 |
| `/capacity` | Pool accounts, limit and use per location and quota, waitlist | `addPoolAccount`, `setCapacityLimit`, `notifyWaitlist` | `ops` | P0 |
| `/operations` | Queues: needs approval, needs attention, running | `approveOperation`, `rejectOperation`, `retryOperation` | `ops` | P0 |
| `/support` | Support requests | `replyByEmail`, `closeRequest` | `support` | P1 |
| `/abuse` | Cases | `openAbuseCase`, `suspendResource`, `closeAbuseCase` | `ops`, `support` | P1 |
| `/reconciliation` | Discrepancies by kind | `resolveDiscrepancy` | `ops`, `finance` | P1 |
| `/audit` | Audit log search | None | All read | P0 |
| `/admins` | Admin users and roles | `inviteAdmin`, `setAdminRole`, `disableAdmin` | `superadmin` | P0 |

### 16.13 States, wording and formats

States that every screen has (rule U11):

| State | Rule |
| --- | --- |
| Loading | Skeleton blocks with the Bootstrap `placeholder` classes inside the final layout. No full-page spinner |
| Empty | An inline SVG illustration, one sentence, one primary button |
| Error | A short message, a reference id (request or operation id) and a retry button. Never a stack trace and never raw error text from AWS or EPS |
| Not allowed | KYC not verified, limit reached or account suspended: say what to do next and link to it |
| Flag off | The coming soon page with "notify me" |

State badges. Each badge has an icon and a text label:

| State | English label | Classes |
| --- | --- | --- |
| Operation running, resource being created | Creating | `badge bg-info text-dark` |
| `active` | Running | `badge bg-success` |
| Stopped by the customer | Stopped | `badge bg-secondary` |
| `grace` | Suspended, renewal due | `badge bg-warning text-dark` |
| `retained` | Deleted, backup kept | `badge bg-grey` |
| Failed or needs attention | Problem | `badge bg-danger` |
| Payment verified, pending, or failed, cancelled and expired | Paid, Pending, Failed | `bg-success`, `bg-warning text-dark`, `bg-secondary` |

AWS statements (rule U6). They are stored as messages and used unchanged:

| Use | English | Bengali |
| --- | --- | --- |
| Short statement: hero, footers, emails | 100% AWS infrastructure. Built on Amazon Lightsail. | ১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি। |
| Long statement: landing page, product pages, FAQ | Every server, database and storage resource you buy here is an Amazon Lightsail resource running in an AWS Region (Singapore or Mumbai). TiCON Cloud sells, bills and supports the service. You manage everything from this panel and do not need an AWS account. | এখানে কেনা প্রতিটি সার্ভার, ডেটাবেস ও স্টোরেজ একটি Amazon Lightsail resource, যা Singapore বা Mumbai AWS Region থেকে চলে। বিক্রি, বিল ও সাপোর্ট TiCON Cloud দেয়। সবকিছু এই প্যানেল থেকেই চালানো যায়, আলাদা AWS account লাগে না। |
| Trademark line: footers of pages and emails | Amazon Web Services, AWS, Amazon Lightsail and Amazon Route 53 are trademarks of Amazon.com, Inc. or its affiliates. | The same line in English |

Wording rules, from the AWS Trademark Guidelines (last updated 2026-11-05). This is a reading of the guidelines, not legal advice; the wording is confirmed with AWS before launch (Section 17).

| Rule | Detail |
| --- | --- |
| Plain text only | No AWS logo and no "Powered by AWS" logo in the product. An AWS Partner badge appears only if TiCON is entitled to it and uses it as the AWS Partner Creative and Messaging Guide says |
| True statements | The 100% statement is true only while every customer resource runs on AWS. If that ever changes, the statement changes first |
| Own brand first | Product names are TiCON Cloud's own. The AWS name follows in a relational phrase: "Cloud Server, built on Amazon Lightsail". No AWS mark inside a product name, a company name or a domain name. An AWS mark in a URL path is allowed for AWS content |
| Exact marks | Write "AWS" and "Amazon Lightsail". Do not write "AWS Lightsail", and do not abbreviate, join or hyphenate a mark with another word. In Bengali prefer wording that leaves the mark standing alone, as in the statements above |
| Prominence | TiCON Cloud branding is always larger and more prominent than any AWS name |
| No implied endorsement | Never say or suggest that AWS sells, supports, sponsors or endorses TiCON Cloud. Say who does: TiCON Cloud sells, bills and supports |
| Reseller notice | If TiCON holds a Solution Provider or Distribution Seller Addendum, the guidelines require a reseller notice with the first AWS mention on a page. Its text comes from that agreement |
| Advertising | No AWS mark in paid search ads unless AWS has authorized it |
| Still hidden | AWS account ids, ARNs, the pool account structure, internal resource names (`tc-...`) and raw AWS error text |

Names in customer-facing text. The AWS name appears on the first mention on a page, in product page titles, in the configure flow, on the resource detail header and on the invoice line. Lists and buttons use the product name alone.

| Internal term | Product name | Bengali | AWS name shown beside it |
| --- | --- | --- | --- |
| Instance | Cloud Server | ক্লাউড সার্ভার | Amazon Lightsail instance |
| Managed database | Managed Database | ম্যানেজড ডেটাবেস | Amazon Lightsail managed database |
| Disk | Block Storage | ব্লক স্টোরেজ | Amazon Lightsail block storage disk |
| Bucket | Object Storage | অবজেক্ট স্টোরেজ | Amazon Lightsail object storage bucket |
| Load balancer | Load Balancer | লোড ব্যালান্সার | Amazon Lightsail load balancer |
| Container service | Container Service | কন্টেইনার সার্ভিস | Amazon Lightsail container service |
| Distribution | CDN | সিডিএন | Amazon Lightsail CDN distribution |
| Static IP | Static IP | স্ট্যাটিক আইপি | Amazon Lightsail static IP |
| Snapshot | Backup | ব্যাকআপ | Amazon Lightsail snapshot |
| Bundle | Plan | প্ল্যান | Amazon Lightsail plan |
| Blueprint | Image | ইমেজ | Amazon Lightsail blueprint |
| Region | Location | লোকেশন | AWS Region with name and code, for example Asia Pacific (Singapore), `ap-southeast-1` |
| DNS zone, domain | DNS, Domain | ডিএনএস, ডোমেইন | Amazon Route 53 |
| Wallet top-up | Top up | টপ আপ | None |
| Base price line | AWS service price | AWS সার্ভিস মূল্য | None |

Formats:

- Money is formatted only by `MoneyText` from minor units. Review, invoices, receipts and the ledger show the exact amount with two decimals. Plan cards and price tables show whole taka rounded up, so a customer is never charged more than the displayed price.
- In the `bn` locale money, dates and counts use Bengali numerals by default. One market setting (`numerals`: `beng` or `latn`) switches them. Technical values (IP addresses, ports, sizes, ids, invoice numbers, commands) are always in Latin digits. Amount inputs accept both digit sets and the server normalizes them.
- Dates are shown in `Asia/Dhaka` time and stored in UTC.
- Shared zod schemas live in `packages/core/validation` and are used by the form and by the action:

| Input | Rule |
| --- | --- |
| Resource label | 1 to 40 characters: letters, digits, hyphen. Display only; it is never an AWS name (R11) |
| Mobile number | Bangladesh mobile format, stored as `+880` followed by ten digits |
| Top-up amount | Whole taka between the market's minimum and maximum |
| Firewall rule | Protocol `tcp`, `udp`, `icmp` or `all`; ports 0 to 65535 with from not above to; source as CIDR. IPv4 and IPv6 rules are separate lists of at most 60 rules each (AWS quota) |
| SSH public key | One line, `ssh-rsa` with at least 2048 bits (ED25519 only after the VERIFY of Section 10.4), at most 10 keys for one customer |
| Domain name | Lower case, IDNA-encoded, label and TLD checked against `tlds` |
| DNS record | Type from the allowed list of Section 12; value checked per type; TTL 60 to 86400 |
| `next` | Rule U12 |

### 16.14 Emails and SMS

Emails use the layout of `email/index.html` (dark header with the logo, one headline band, white body, dark footer with the company address), rebuilt in `packages/notify` as table-based templates with inline CSS, in `bn` and `en`. Hex values come from 16.4. No password, key, OTP or document number is ever sent by email, and links go only to the panel's own domain. The footer of every email carries the short AWS statement and the trademark line of 16.13.

| Trigger | Email | SMS |
| --- | --- | --- |
| Sign-up and verification | Welcome; email code (Cognito) | Phone OTP |
| KYC | Received, approved, rejected with the reason | Approved |
| Top-up verified | Receipt | No |
| Order paid | Invoice | No |
| Resource ready | Location and address, link to the panel | Yes |
| Renewal reminders at 7, 3 and 1 day | Amount and wallet balance | At 1 day |
| Renewed | Invoice | No |
| Grace started | What is suspended and until when | Yes |
| Resource destroyed, backup kept | Restore deadline | Yes |
| Backups purged | Notice | No |
| Low balance, payment expired | Notice | No |
| Security: new sign-in, password changed, TOTP changed, email or phone changed | Alert | Yes |
| Domain: contact verification pending, renewal reminders at 60, 30 and 7 days | Notice | At 7 days |

### 16.15 Mockup pages that are not built

`blackfriday`, `blog-details`, `blog-grid`, `colocation`, `cryptoexchange`, `cryptotrading`, `ddos`, `dedicated`, `developer`, `email`, `emailsecurity`, `empty`, `gaming`, `gsuite`, `header-icons`, `home3d`, `homegaming`, `homeimage`, `homevideo`, `hosting`, `iptv`, `magento`, `radiostream`, `reseller`, `seo`, `settings`, `ssl`, `voice`, `voip`, `vpn` (all `.html` in `template/`). `elements.html`, `sections.html` and `sliders.html` are references for blocks. Candidates after launch: `about.html` (company page), `datacenter.html` (locations), `wordpress.html` (a landing page for WordPress on Cloud Servers), `promos.html` (offers).

### 16.16 UI acceptance checks

- [ ] `/dev/ui` (not in production) shows every kit component with the customer and the admin attributes, in `bn` and `en`, at 360, 768 and 1280 px.
- [ ] CSP in report-only mode on staging shows zero violations across the P0 screens. Then it is enforced.
- [ ] The network log of the P0 screens shows no request to another origin, except the KYC upload to the platform's own bucket and the navigation to EPS.
- [ ] The build output contains no jQuery and no file from the theme's `assets/js`.
- [ ] Automated accessibility checks (axe) report no serious or critical issue on the P0 screens, and every P0 flow can be completed with the keyboard.
- [ ] Bengali text renders correctly on Android Chrome and iOS Safari, including conjuncts, numerals and the taka sign.
- [ ] Public pages, the panel footer and emails carry the AWS statement and the trademark line of 16.13. A test checks the message files for forbidden forms such as "AWS Lightsail".
- [ ] A test searches rendered P0 pages, emails and API responses for `arn:aws:`, the pool account ids and internal resource names and finds none.
- [ ] Largest Contentful Paint is under 2.5 seconds on the landing and pricing pages on a simulated 4G phone.
- [ ] Playwright completes sign-up, top-up and create-server at a width of 360 px in `bn`.

