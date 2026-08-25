# Homepage hero reference notes

Observed from the live San Ramon FC homepage on August 24, 2026, using desktop and mobile browser renders of <https://www.sanramonfc.com/>. These notes describe layout behavior only; CalBlue uses its own code, copy, colors, logo, and photographs.

## Desktop reference

- The header is a solid navy bar above the visible hero image. At a 1440 px viewport it is about 122 px tall, with the crest at the left, centered navigation, and registration/login actions at the right. It remains a prominent navigation layer instead of disappearing into the photograph.
- The hero content is horizontally centered and placed slightly above the visual midpoint of the image area.
- `WE ARE` is a lightweight 24 px kicker. A centered divider roughly 162 px wide separates it from the club name.
- `SAN RAMON FC` is the dominant 96 px condensed uppercase headline, approximately four times the kicker size.
- The main registration action is centered below the headline. It is approximately 296 by 67 px, red with white uppercase type, and reads `REGISTER - ALL PROGRAMS`.
- The background fills the hero with `cover` cropping and a centered horizontal position. The visible slide centers a player in the action while retaining surrounding match context.
- A neutral black overlay is applied at about 36% opacity. The photo remains recognizable and relatively bright.
- The background gallery contains eight images and declares a 3-second slide speed. The transition is a fade rather than a horizontal slide.

## Mobile reference

- At a 390 px viewport the header becomes a tall navy block with a centered crest and a hamburger at the left.
- The same centered type and button hierarchy is retained, but the live reference has substantial horizontal overflow: the headline and button run beyond the viewport, and the cover crop cuts off much of the subject.
- CalBlue follows the useful hierarchy, not those overflow defects. Its mobile headline and button are constrained to the viewport, the hero is kept to 620 px, and each 4:3 photograph is shown in a shallower image region to avoid an extreme portrait crop.

## CalBlue application

- Keep the existing four CalBlue match photographs and brand colors.
- Use a small centered `WE ARE`, a short divider, and a dominant centered `CALBLUE FC` headline.
- Keep one centered `REGISTER TO JOIN US` action, with the existing supporting sentence centered underneath the headline.
- Replace the left-heavy overlay with a lighter neutral scrim and preserve per-photo mobile focal points.
- Use a 4-second-per-photo cycle with a soft crossfade. This stays close to the reference's brisk slideshow without making CalBlue's four-photo loop feel frantic.
