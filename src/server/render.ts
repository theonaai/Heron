/**
 * Shared HTML rendering primitives used by:
 *   - The live `heron serve` HTTP server (interview sessions, scan dashboard).
 *   - The static `heron scan --format html` output (self-contained .html file).
 *
 * Extracted from `src/server/index.ts` in the AAP-52 refactor so that the
 * same `markdownToHtml` + `SHARED_CSS` + favicon SVG can be used from the
 * CLI scan pipeline without dragging in the `node:http` request handlers.
 *
 * Discipline:
 *  - No imports from `node:http` here — this module must work in the CLI
 *    process where no server is running.
 *  - `markdownToHtml` is intentionally minimal: header / paragraph / table /
 *    list / blockquote / bold / italic. The Heron report templates emit
 *    a constrained subset of Markdown; we own both sides of the contract.
 *  - HTML escape is applied to the raw input BEFORE Markdown patterns
 *    rewrite headings/tables/etc. The only HTML tags we unescape back are
 *    a small allow-list (`details`, `summary`, `strong`, `em`) that the
 *    Heron templates emit verbatim.
 */

/**
 * Self-contained Heron favicon as inline SVG. Inlined so static HTML files
 * (and Docker builds without /favicon.svg) carry the brand without an
 * external request.
 */
export const HERON_FAVICON_SVG = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 20010904//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">
<svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="1024.000000pt" height="1024.000000pt" viewBox="0 0 1024.000000 1024.000000" preserveAspectRatio="xMidYMid meet">
<g transform="translate(0.000000,1024.000000) scale(0.100000,-0.100000)" fill="#000000" stroke="none">
<path d="M5215 8809 c-197 -172 -573 -433 -855 -594 -602 -344 -1270 -553 -1890 -593 l-105 -7 0 -1480 c0 -1603 -2 -1546 56 -1844 111 -567 393 -1107 817 -1561 337 -362 724 -659 1247 -959 163 -94 562 -298 714 -366 101 -45 77 -50 338 76 451 216 888 476 1208 717 382 286 719 632 938 961 258 387 441 854 501 1276 34 241 36 343 36 1756 l0 1417 -22 6 c-13 3 -43 6 -68 6 -154 0 -596 79 -872 156 -622 172 -1297 536 -1855 1001 -62 51 -113 93 -115 93 -2 0 -34 -28 -73 -61z m115 -120 c19 -16 105 -83 190 -148 492 -373 976 -633 1510 -811 308 -103 540 -154 903 -202 l178 -23 -4 -1425 c-3 -1019 -7 -1449 -16 -1510 -52 -382 -141 -675 -297 -990 -129 -260 -253 -444 -455 -680 -411 -479 -973 -882 -1800 -1290 l-245 -121 -45 19 c-189 82 -630 313 -839 439 -389 235 -654 436 -944 714 -592 568 -932 1271 -986 2039 -6 87 -10 676 -10 1476 l0 1331 73 7 c657 63 1281 265 1887 611 245 139 570 362 783 536 40 33 74 59 77 59 3 0 21 -14 40 -31z"/>
<path d="M5205 8396 c-398 -307 -784 -539 -1205 -724 -369 -162 -774 -276 -1198 -338 l-123 -18 4 -1365 c3 -1358 3 -1367 25 -1481 50 -259 106 -456 184 -640 229 -540 599 -986 1168 -1407 264 -195 661 -428 1054 -619 l176 -85 227 113 c680 340 1136 651 1515 1035 197 200 274 295 418 515 238 363 389 786 435 1218 12 111 15 369 15 1427 l0 1292 -57 6 c-119 14 -434 77 -598 120 -647 168 -1260 477 -1860 939 -44 34 -84 65 -90 68 -5 3 -46 -22 -90 -56z m208 -150 c524 -400 1122 -702 1735 -875 141 -40 494 -114 605 -127 l58 -7 -4 -1291 c-4 -1433 1 -1338 -73 -1655 -192 -825 -739 -1491 -1699 -2068 -178 -107 -422 -239 -611 -330 l-138 -66 -205 102 c-533 266 -943 530 -1278 825 -316 277 -547 567 -720 903 -152 292 -235 553 -290 903 -17 106 -18 212 -18 1394 l0 1280 163 27 c794 132 1523 455 2222 983 69 52 126 95 128 95 1 1 57 -41 125 -93z"/>
<path d="M5542 7460 c-94 -25 -165 -57 -337 -151 -199 -109 -317 -145 -442 -132 -51 6 -57 4 -45 -9 22 -27 97 -41 180 -35 93 8 173 32 267 79 l70 36 -95 -97 c-52 -53 -110 -122 -129 -153 -53 -91 -91 -212 -90 -288 0 -73 0 -73 52 67 18 50 49 118 68 150 32 54 214 251 224 242 2 -3 -7 -28 -21 -57 -61 -127 -70 -321 -21 -454 56 -155 138 -246 303 -338 177 -99 237 -164 270 -290 37 -145 -25 -266 -127 -246 -19 3 -61 27 -94 52 -168 128 -329 153 -540 83 -173 -58 -347 -180 -540 -380 -187 -194 -318 -386 -464 -684 -106 -215 -150 -321 -230 -560 -60 -179 -136 -454 -127 -462 9 -9 44 8 125 61 44 30 81 53 81 52 0 -1 -15 -47 -33 -102 -19 -54 -37 -116 -41 -136 l-7 -38 28 11 c86 32 200 98 284 163 85 66 150 132 294 300 38 44 47 48 155 80 63 19 152 47 198 64 45 16 84 27 86 23 2 -3 7 -51 11 -106 6 -80 4 -112 -10 -160 -60 -217 -90 -315 -106 -353 -25 -59 -24 -80 16 -277 51 -257 139 -800 132 -818 -5 -15 -24 -17 -132 -17 -150 0 -195 -16 -195 -71 0 -5 268 -9 665 -9 366 0 665 2 665 5 0 18 -36 55 -62 64 -17 6 -99 11 -182 11 -196 0 -210 6 -243 105 -13 39 -53 176 -89 305 -36 129 -83 298 -106 375 -38 130 -40 148 -39 255 1 91 10 157 42 315 38 183 47 212 108 350 37 82 84 198 105 256 36 100 40 108 89 145 29 21 101 88 160 149 103 105 107 108 88 65 -63 -144 -101 -424 -70 -530 l12 -45 8 30 c3 17 7 50 8 75 3 107 62 327 124 465 42 95 107 218 112 213 2 -2 -5 -35 -15 -75 -31 -121 -43 -260 -30 -344 13 -87 30 -114 30 -48 0 122 45 322 110 489 76 195 141 384 162 470 28 111 30 340 4 444 -65 267 -225 462 -468 569 -62 28 -122 77 -144 118 -18 36 -18 122 1 159 8 16 29 39 47 52 31 22 45 23 233 29 155 5 218 11 279 27 l79 21 331 -24 c360 -27 426 -30 426 -16 0 5 -22 18 -50 30 -48 21 -647 221 -723 242 -21 5 -66 34 -100 62 -95 80 -120 96 -210 129 -110 41 -263 49 -375 18z m436 -154 c32 -12 89 -42 127 -65 48 -28 133 -62 273 -107 111 -37 201 -68 200 -70 -4 -3 -191 27 -414 66 -130 23 -198 26 -192 8 4 -12 85 -49 133 -62 15 -4 17 -8 8 -17 -8 -8 -66 -11 -190 -10 -98 0 -201 -4 -230 -10 -169 -34 -241 -223 -142 -373 32 -48 79 -81 204 -145 44 -22 106 -61 137 -86 231 -182 327 -557 222 -872 -63 -189 -210 -400 -384 -551 -86 -74 -289 -217 -297 -208 -2 2 4 21 15 43 35 69 99 286 112 380 23 165 0 263 -79 342 -97 97 -254 90 -437 -20 -69 -42 -164 -126 -164 -145 0 -23 24 -16 91 27 141 92 236 129 329 129 76 0 126 -30 159 -95 70 -136 0 -369 -174 -576 -53 -64 -181 -179 -199 -179 -3 0 3 19 15 42 54 105 99 265 99 349 0 32 -3 40 -16 37 -11 -2 -23 -29 -39 -88 -71 -272 -182 -433 -364 -524 -56 -29 -56 -27 -6 44 69 97 138 259 150 353 6 48 5 57 -8 57 -9 0 -22 -19 -33 -47 -79 -216 -171 -364 -296 -477 -54 -50 -186 -126 -217 -126 -7 0 11 28 41 63 76 88 131 172 194 292 51 99 65 147 45 159 -12 8 -35 -21 -66 -84 -49 -98 -152 -243 -239 -336 -73 -79 -225 -216 -264 -238 -20 -12 157 335 232 454 65 103 72 120 60 133 -16 15 -49 -22 -128 -141 -91 -137 -164 -268 -237 -426 -45 -97 -47 -101 -128 -159 -45 -33 -83 -58 -85 -56 -3 2 17 76 44 164 49 164 162 453 243 628 248 529 649 958 999 1065 179 56 304 33 450 -81 94 -74 180 -85 258 -33 74 49 115 183 91 295 -31 144 -120 249 -302 354 -143 82 -207 143 -253 240 -58 122 -69 220 -40 350 22 97 48 149 106 212 87 96 214 135 347 106 49 -10 54 -9 89 14 46 31 77 31 150 1z m-816 -3151 c1 -52 -68 -386 -96 -464 -23 -63 -20 -93 19 -211 43 -131 245 -857 245 -882 0 -17 -11 -18 -153 -18 -136 0 -156 2 -170 18 -30 33 -28 20 -137 661 -36 210 -40 245 -34 345 8 165 74 394 165 582 38 77 83 162 101 190 l32 49 13 -110 c8 -60 14 -132 15 -160z"/>
<path d="M5861 7271 c-21 -14 -18 -69 5 -86 23 -17 39 -18 65 -5 22 12 27 68 7 88 -14 14 -57 16 -77 3z"/>
</g>
</svg>`;

/** Link tag pointing at the favicon SVG endpoint (`/favicon.svg`). */
export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`;

/** Inline Heron logo SVG used in the page header. */
export const HERON_LOGO = `<svg width="36" height="36" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0,1024) scale(0.1,-0.1)" fill="#0f172a" stroke="none"><path d="M5215 8809 c-197 -172 -573 -433 -855 -594 -602 -344 -1270 -553 -1890 -593 l-105 -7 0 -1480 c0 -1603 -2 -1546 56 -1844 111 -567 393 -1107 817 -1561 337 -362 724 -659 1247 -959 163 -94 562 -298 714 -366 101 -45 77 -50 338 76 451 216 888 476 1208 717 382 286 719 632 938 961 258 387 441 854 501 1276 34 241 36 343 36 1756 l0 1417 -22 6 c-13 3 -43 6 -68 6 -154 0 -596 79 -872 156 -622 172 -1297 536 -1855 1001 -62 51 -113 93 -115 93 -2 0 -34 -28 -73 -61z m115 -120 c19 -16 105 -83 190 -148 492 -373 976 -633 1510 -811 308 -103 540 -154 903 -202 l178 -23 -4 -1425 c-3 -1019 -7 -1449 -16 -1510 -52 -382 -141 -675 -297 -990 -129 -260 -253 -444 -455 -680 -411 -479 -973 -882 -1800 -1290 l-245 -121 -45 19 c-189 82 -630 313 -839 439 -389 235 -654 436 -944 714 -592 568 -932 1271 -986 2039 -6 87 -10 676 -10 1476 l0 1331 73 7 c657 63 1281 265 1887 611 245 139 570 362 783 536 40 33 74 59 77 59 3 0 21 -14 40 -31z"/><path d="M5205 8396 c-398 -307 -784 -539 -1205 -724 -369 -162 -774 -276 -1198 -338 l-123 -18 4 -1365 c3 -1358 3 -1367 25 -1481 50 -259 106 -456 184 -640 229 -540 599 -986 1168 -1407 264 -195 661 -428 1054 -619 l176 -85 227 113 c680 340 1136 651 1515 1035 197 200 274 295 418 515 238 363 389 786 435 1218 12 111 15 369 15 1427 l0 1292 -57 6 c-119 14 -434 77 -598 120 -647 168 -1260 477 -1860 939 -44 34 -84 65 -90 68 -5 3 -46 -22 -90 -56z m208 -150 c524 -400 1122 -702 1735 -875 141 -40 494 -114 605 -127 l58 -7 -4 -1291 c-4 -1433 1 -1338 -73 -1655 -192 -825 -739 -1491 -1699 -2068 -178 -107 -422 -239 -611 -330 l-138 -66 -205 102 c-533 266 -943 530 -1278 825 -316 277 -547 567 -720 903 -152 292 -235 553 -290 903 -17 106 -18 212 -18 1394 l0 1280 163 27 c794 132 1523 455 2222 983 69 52 126 95 128 95 1 1 57 -41 125 -93z"/><path d="M5542 7460 c-94 -25 -165 -57 -337 -151 -199 -109 -317 -145 -442 -132 -51 6 -57 4 -45 -9 22 -27 97 -41 180 -35 93 8 173 32 267 79 l70 36 -95 -97 c-52 -53 -110 -122 -129 -153 -53 -91 -91 -212 -90 -288 0 -73 0 -73 52 67 18 50 49 118 68 150 32 54 214 251 224 242 2 -3 -7 -28 -21 -57 -61 -127 -70 -321 -21 -454 56 -155 138 -246 303 -338 177 -99 237 -164 270 -290 37 -145 -25 -266 -127 -246 -19 3 -61 27 -94 52 -168 128 -329 153 -540 83 -173 -58 -347 -180 -540 -380 -187 -194 -318 -386 -464 -684 -106 -215 -150 -321 -230 -560 -60 -179 -136 -454 -127 -462 9 -9 44 8 125 61 44 30 81 53 81 52 0 -1 -15 -47 -33 -102 -19 -54 -37 -116 -41 -136 l-7 -38 28 11 c86 32 200 98 284 163 85 66 150 132 294 300 38 44 47 48 155 80 63 19 152 47 198 64 45 16 84 27 86 23 2 -3 7 -51 11 -106 6 -80 4 -112 -10 -160 -60 -217 -90 -315 -106 -353 -25 -59 -24 -80 16 -277 51 -257 139 -800 132 -818 -5 -15 -24 -17 -132 -17 -150 0 -195 -16 -195 -71 0 -5 268 -9 665 -9 366 0 665 2 665 5 0 18 -36 55 -62 64 -17 6 -99 11 -182 11 -196 0 -210 6 -243 105 -13 39 -53 176 -89 305 -36 129 -83 298 -106 375 -38 130 -40 148 -39 255 1 91 10 157 42 315 38 183 47 212 108 350 37 82 84 198 105 256 36 100 40 108 89 145 29 21 101 88 160 149 103 105 107 108 88 65 -63 -144 -101 -424 -70 -530 l12 -45 8 30 c3 17 7 50 8 75 3 107 62 327 124 465 42 95 107 218 112 213 2 -2 -5 -35 -15 -75 -31 -121 -43 -260 -30 -344 13 -87 30 -114 30 -48 0 122 45 322 110 489 76 195 141 384 162 470 28 111 30 340 4 444 -65 267 -225 462 -468 569 -62 28 -122 77 -144 118 -18 36 -18 122 1 159 8 16 29 39 47 52 31 22 45 23 233 29 155 5 218 11 279 27 l79 21 331 -24 c360 -27 426 -30 426 -16 0 5 -22 18 -50 30 -48 21 -647 221 -723 242 -21 5 -66 34 -100 62 -95 80 -120 96 -210 129 -110 41 -263 49 -375 18z m436 -154 c32 -12 89 -42 127 -65 48 -28 133 -62 273 -107 111 -37 201 -68 200 -70 -4 -3 -191 27 -414 66 -130 23 -198 26 -192 8 4 -12 85 -49 133 -62 15 -4 17 -8 8 -17 -8 -8 -66 -11 -190 -10 -98 0 -201 -4 -230 -10 -169 -34 -241 -223 -142 -373 32 -48 79 -81 204 -145 44 -22 106 -61 137 -86 231 -182 327 -557 222 -872 -63 -189 -210 -400 -384 -551 -86 -74 -289 -217 -297 -208 -2 2 4 21 15 43 35 69 99 286 112 380 23 165 0 263 -79 342 -97 97 -254 90 -437 -20 -69 -42 -164 -126 -164 -145 0 -23 24 -16 91 27 141 92 236 129 329 129 76 0 126 -30 159 -95 70 -136 0 -369 -174 -576 -53 -64 -181 -179 -199 -179 -3 0 3 19 15 42 54 105 99 265 99 349 0 32 -3 40 -16 37 -11 -2 -23 -29 -39 -88 -71 -272 -182 -433 -364 -524 -56 -29 -56 -27 -6 44 69 97 138 259 150 353 6 48 5 57 -8 57 -9 0 -22 -19 -33 -47 -79 -216 -171 -364 -296 -477 -54 -50 -186 -126 -217 -126 -7 0 11 28 41 63 76 88 131 172 194 292 51 99 65 147 45 159 -12 8 -35 -21 -66 -84 -49 -98 -152 -243 -239 -336 -73 -79 -225 -216 -264 -238 -20 -12 157 335 232 454 65 103 72 120 60 133 -16 15 -49 -22 -128 -141 -91 -137 -164 -268 -237 -426 -45 -97 -47 -101 -128 -159 -45 -33 -83 -58 -85 -56 -3 2 17 76 44 164 49 164 162 453 243 628 248 529 649 958 999 1065 179 56 304 33 450 -81 94 -74 180 -85 258 -33 74 49 115 183 91 295 -31 144 -120 249 -302 354 -143 82 -207 143 -253 240 -58 122 -69 220 -40 350 22 97 48 149 106 212 87 96 214 135 347 106 49 -10 54 -9 89 14 46 31 77 31 150 1z m-816 -3151 c1 -52 -68 -386 -96 -464 -23 -63 -20 -93 19 -211 43 -131 245 -857 245 -882 0 -17 -11 -18 -153 -18 -136 0 -156 2 -170 18 -30 33 -28 20 -137 661 -36 210 -40 245 -34 345 8 165 74 394 165 582 38 77 83 162 101 190 l32 49 13 -110 c8 -60 14 -132 15 -160z"/><path d="M5861 7271 c-21 -14 -18 -69 5 -86 23 -17 39 -18 65 -5 22 12 27 68 7 88 -14 14 -57 16 -77 3z"/></g></svg>`;

/**
 * Shared CSS used by every Heron HTML page (interview sessions, scan
 * dashboard, scan detail, approval chain). Inlined into a `<style>` block
 * so static HTML files dropped on disk remain fully self-contained.
 */
export const SHARED_CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; color: #1a1a1a; background: #fafbfc; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.85em; }
  pre { background: #1a1a2e; color: #e0e0e0; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85em; }

  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; justify-content: center; }
  .header h1 { font-size: 1.4rem; margin: 0; }
  .header-sub { color: #6b7280; margin: 0 0 32px 0; font-size: 0.95em; text-align: center; }
  .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 0.8em; text-align: center; }
  .footer a { color: #9ca3af; }

  .badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 0.8em; font-weight: 600; }
  .badge-interviewing { background: #fef3c7; color: #92400e; }
  .badge-analyzing { background: #dbeafe; color: #1e40af; }
  .badge-complete { background: #d1fae5; color: #065f46; }
  .badge-completed { background: #d1fae5; color: #065f46; }
  .badge-pending { background: #fef3c7; color: #92400e; }
  .badge-failed { background: #fee2e2; color: #991b1b; }
  .badge-error { background: #fee2e2; color: #991b1b; }
  .risk { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 0.8em; font-weight: 700; }
  .risk-low { background: #d1fae5; color: #065f46; }
  .risk-medium { background: #fef3c7; color: #92400e; }
  .risk-high { background: #fee2e2; color: #991b1b; }
  .risk-critical { background: #991b1b; color: #fff; }

  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; border: 1px solid #e5e7eb; }
  th { background: #f9fafb; font-weight: 600; font-size: 0.85em; text-transform: uppercase; color: #6b7280; letter-spacing: 0.03em; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #e5e7eb; }
  tbody tr:hover { background: #f0f7ff; }
  tbody tr:last-child td { border-bottom: none; }

  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  .empty { color: #6b7280; padding: 40px 0; text-align: center; }

  .qa { margin-bottom: 16px; padding: 12px 16px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; }
  .q { font-weight: 600; margin-bottom: 6px; line-height: 1.5; }
  .a { color: #374151; white-space: pre-wrap; line-height: 1.5; }
  .cat { display: inline-block; background: #eff6ff; padding: 1px 8px; border-radius: 3px; font-size: 0.7em; color: #3b82f6; font-weight: 600; margin-right: 8px; text-transform: uppercase; letter-spacing: 0.04em; }

  .report-rendered { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; line-height: 1.6; }
  .report-rendered h1 { font-size: 1.5em; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
  .report-rendered h2 { font-size: 1.2em; margin-top: 28px; border-bottom: 1px solid #f0f0f0; padding-bottom: 6px; color: #1e293b; }
  /*
    Long unbreakable tokens in cells (e.g. an OAuth scope URL inside a
    finding description) used to push the Description column wide enough
    to squeeze the Finding column down to one word per line. table-layout
    fixed allocates columns proportionally regardless of content; the
    overflow-wrap rule lets long URLs break mid-word so they fit the
    allocated width.
  */
  .report-rendered table { margin: 12px 0; font-size: 0.9em; table-layout: fixed; }
  .report-rendered table th, .report-rendered table td { overflow-wrap: anywhere; word-break: break-word; vertical-align: top; }
  .report-rendered p { margin: 8px 0; }
  .report-rendered strong { color: #0f172a; }
  .report-rendered hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  .report-rendered ol, .report-rendered ul { padding-left: 24px; }
  .report-rendered li { margin: 4px 0; }
  .report-rendered details { margin-top: 16px; }
  .report-rendered summary { cursor: pointer; font-weight: 600; color: #2563eb; }
  .report-rendered blockquote { border-left: 3px solid #f59e0b; background: #fffbeb; padding: 12px 16px; margin: 12px 0; border-radius: 0 6px 6px 0; color: #92400e; }
  .report-rendered h3 { font-size: 1.05em; margin-top: 20px; color: #334155; }

  .copy-block { position: relative; }
  .copy-block pre { white-space: pre-wrap; word-break: break-all; overflow-x: hidden; }
  .copy-btn { position: absolute; top: 8px; right: 8px; background: #374151; color: #e5e7eb; border: 1px solid #4b5563; padding: 6px; border-radius: 4px; cursor: pointer; opacity: 0.7; transition: opacity 0.15s; display: flex; align-items: center; justify-content: center; }
  .copy-btn:hover { opacity: 1; background: #4b5563; }
  .copy-btn.copied { background: #065f46; border-color: #065f46; color: #d1fae5; }
  .copy-btn svg { width: 16px; height: 16px; }

  .btn { display: inline-block; background: #2563eb; color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 0.9em; font-weight: 500; }
  .btn:hover { background: #1d4ed8; text-decoration: none; }
  .btn-outline { background: transparent; color: #2563eb; border: 1px solid #2563eb; }
  .btn-outline:hover { background: #eff6ff; }
  .report-actions { margin-bottom: 20px; display: flex; gap: 10px; }
  .meta { color: #6b7280; margin-bottom: 24px; }
  .analyzing { color: #1e40af; font-style: italic; }
  .error-msg { color: #991b1b; background: #fee2e2; padding: 12px; border-radius: 6px; }

  /* AAP-52 scan + approval pages */
  .breadcrumb { color: #6b7280; margin: 0 0 16px 0; font-size: 0.9em; }
  .integrity-ok { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-weight: 500; }
  .integrity-broken { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-weight: 600; }
  .pending-banner { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; }
`;

/**
 * Escape HTML metacharacters: `&`, `<`, `>`, `"`.
 *
 * Exported so callers building HTML outside `markdownToHtml` (e.g. the
 * scan list table) can use the same helper.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert the constrained Markdown subset emitted by Heron report
 * templates into HTML. NOT a general-purpose Markdown parser — only
 * the constructs we actually emit.
 *
 * The function escapes the entire input FIRST, then runs structural
 * rewrites (headers / tables / lists / blockquotes / bold / italic).
 * A small allow-list of inline HTML tags (`details`, `summary`,
 * `strong`, `em`) is unescaped at the end so the template's literal
 * `<details>` / `<summary><strong>...</strong></summary>` blocks
 * survive intact.
 */
export function markdownToHtml(md: string): string {
  let html = escapeHtml(md);

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Headers (most specific first — #### before ### before ## before #)
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*\[([A-Z]+)\]\s*(.+?)\*\*/g, '<strong>[$1] $2</strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Details/summary + safe inline tags inside them.
  // The Top-3 + "Additional findings" block in templates.ts wraps the
  // summary label in <strong>, e.g. "<summary><strong>Additional findings
  // (2)</strong></summary>". escapeHtml() above turned the inner <strong>
  // into &lt;strong&gt;, which used to leak into the rendered HTML as
  // literal text. Unescape these inline tags too — they are the only HTML
  // we ever emit from the markdown templates, so a global pass is safe.
  html = html.replace(/&lt;details&gt;/g, '<details>');
  html = html.replace(/&lt;\/details&gt;/g, '</details>');
  html = html.replace(/&lt;summary&gt;([\s\S]+?)&lt;\/summary&gt;/g, '<summary>$1</summary>');
  html = html.replace(/&lt;(\/?)(strong|em)&gt;/g, '<$1$2>');

  // Tables
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => !r.match(/^\|[\s\-:|]+\|$/));
    if (rows.length === 0) return tableBlock;
    const parseRow = (row: string) => row.split('|').slice(1, -1).map(c => c.trim());
    const headerCells = parseRow(rows[0]);
    const thead = '<thead><tr>' + headerCells.map(c => `<th>${c}</th>`).join('') + '</tr></thead>';
    const tbody = rows.slice(1).map(row => {
      const cells = parseRow(row);
      return '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
    }).join('');
    return `<table>${thead}<tbody>${tbody}</tbody></table>`;
  });

  // Blockquotes
  html = html.replace(/((?:^&gt; .+$\n?)+)/gm, (block) => {
    const content = block.replace(/^&gt; /gm, '').trim();
    return `<blockquote>${content}</blockquote>`;
  });

  // Unordered lists
  html = html.replace(/((?:^- .+$\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => {
      const content = l.replace(/^- /, '');
      return `<li>${content}</li>`;
    }).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+$\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Italic (single *)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Paragraphs — wrap remaining loose text lines
  html = html.replace(/^(?!<[htouda\-bl]|<li|<hr|<str|<sum|<det|<ul|<ol|<em|$)(.+)$/gm, '<p>$1</p>');

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

/**
 * Options for the standalone HTML shell.
 *
 * `metaRefreshSeconds` is used by the pending-scan page to poll for
 * completion without any JavaScript. CLI-rendered static HTML never
 * sets it.
 */
export interface RenderHtmlShellOptions {
  /** Optional meta refresh interval in seconds. */
  metaRefreshSeconds?: number;
}

/**
 * Wrap a body fragment in a complete HTML document — DOCTYPE,
 * `<head>` (title + favicon + shared CSS), `<body>` with the Heron
 * page header and footer. Used by every scan/approval page and by
 * the static `--format html` output.
 *
 * Self-contained: no external scripts or stylesheets, so a `.html`
 * file dropped on disk works in a browser without a network.
 */
export function renderHtmlShell(
  title: string,
  body: string,
  opts: RenderHtmlShellOptions = {},
): string {
  const escapedTitle = escapeHtml(title);
  const refresh = opts.metaRefreshSeconds
    ? `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(opts.metaRefreshSeconds))}">`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapedTitle}</title>
${FAVICON_LINK}
${refresh}
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="header">${HERON_LOGO}<h1>Heron</h1></div>
${body}
<div class="footer">Powered by <a href="https://github.com/theonaai/Heron">Heron</a> &mdash; open-source agent checkpoint</div>
</body>
</html>`;
}
