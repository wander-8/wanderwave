# Home Page Layout Redesign (Model 3: Platform-Aware Mode Selector)

**Date:** 2026-11-02  
**Author:** Claude Haiku 4.5  
**Status:** Design Review

---

## Intent & Why

Current home page layout feels arbitrary — header, avatar, featured banner, and mode selector are spatially disconnected. Users don't get a clear sense of visual priority or how to navigate between media types (movies, anime, drama, manga, novels, music).

We're redesigning to make the layout **intentional** by:
1. Integrating the current media mode into the header (next to logo)
2. Using platform-specific UI for mode selection (popover on desktop, bottom sheet on mobile)
3. Keeping featured content visible and un-hidden by menus
4. Making mode discovery obvious without taking up vertical space

**Target audience:** Light/casual users who want to quickly pick what to watch/read tonight, not cinephiles.

---

## Goals & Non-Goals

### Goals
- Layout feels intentional, not arbitrary
- Light users can see current mode at a glance (in header chip)
- Mode switching is discoverable and requires minimal interaction (one tap/click)
- Featured content is never hidden by the mode selector menu
- Works on both desktop (popover) and mobile (bottom sheet) without feeling cramped

### Non-Goals
- Add new features or filtering logic
- Change the featured banner itself
- Redesign the content grid or card layout
- Add gamification or status rankings

### Anti-Goals
- Do not hide mode selector in a hamburger menu (reduces discovery)
- Do not take up significant vertical space for mode selection (delays content)
- Do not make mode switching require multiple steps

---

## Constraints

- Single static HTML file (no build step, no framework changes)
- Supabase + Deno edge functions unchanged
- Mobile-first responsive design (responsive sizing, element caps)
- Must work on existing mobile (~320px) and desktop (~1100px) viewports

---

## The Design: Model 3 (Platform-Aware)

### Layout Structure

```
┌─────────────────────────────────────────┐
│ Header (gradient)                       │
│ ├─ Logo: "Wander_Wave"                 │
│ ├─ Current Mode Chip: "映画 ▼"         │
│ └─ Avatar (top-right)                  │
├─ [POPOVER on desktop / BOTTOM SHEET on mobile when mode chip clicked]
├─ Featured Banner (gradient)             │
├─ Search Box                             │
└─ Content Grid (movies, anime, etc.)    │
```

### Desktop: Popover

- **Trigger:** User clicks "映画 ▼" chip in header
- **Appearance:** Small popover appears below the chip, 2×3 grid layout
  - 映画, ドラマ, アニメ  
  - 漫画, 小説, 音楽
- **Styling:** White background, rounded corners, shadow, compact (fit within header zone)
- **Behavior:** Click a mode → popover closes, header chip text updates to selected mode, content grid refreshes (sticky mode switch)
- **Animation:** Fade-in (subtle, ~150ms)

### Mobile: Bottom Sheet

- **Trigger:** User taps "映画 ▼" chip in header
- **Appearance:** Bottom sheet slides up from bottom, 3 column grid layout
  - Header/drag handle (visual affordance: light gray bar)
  - Title: "メディアを選択"
  - 3×2 grid of mode buttons (large tap targets: 16px+ padding)
  - 映画, ドラマ, アニメ  
  - 漫画, 小説, 音楽
- **Styling:** White background, rounded top corners, shadow, full width on mobile
- **Behavior:** Same as popover — tap a mode → bottom sheet closes, header updates, content refreshes
- **Animation:** Slide up from bottom (~200ms easing)

### Styling Details

**Mode Chip in Header:**
- Positioned: next to logo (left side of header), with ~8px gap
- Appearance: white text on semi-transparent white background (rgba(255,255,255,0.2))
- Border: 1px rgba(255,255,255,0.4)
- Border-radius: 12px
- Padding: 4px 10px
- Font: 12px, no weight change
- Cursor: pointer (indicates clickability)
- Responsive: On mobile, shorten to "W_W" (initials) or similar if space is tight

**Popover (Desktop):**
- Position: absolute, anchored below chip, centered
- Width: ~200px (fits 6 modes in 2×3)
- Background: white
- Border: 1px #ddd
- Border-radius: 8px
- Padding: 8px (grid gap: 8px)
- Shadow: 0 4px 12px rgba(0,0,0,0.15)
- Z-index: high (above featured content)

**Bottom Sheet (Mobile):**
- Position: fixed, bottom: 0
- Width: 100%
- Border-radius: 12px 12px 0 0
- Padding: 20px
- Shadow: 0 -4px 12px rgba(0,0,0,0.1)
- Drag handle: 36px × 4px, centered, gray, ~16px margin-bottom
- Title: "メディアを選択", 14px font-weight: 600
- Grid: 3 columns, gap 12px
- Mode buttons: 16px padding (large tap targets)
- Z-index: very high (above all page content)

---

## Behavior & State Management

### Mode Switch Flow

1. User clicks/taps mode chip in header
2. Popover (desktop) / Bottom sheet (mobile) appears with all 6 modes
3. Current mode is highlighted (dark background + white text)
4. User clicks/taps a different mode
5. **Immediate updates:**
   - Header chip text changes to selected mode
   - Popover/bottom sheet closes
   - Content grid refreshes to show that media type
   - Page scroll position: preserve or reset (TBD by builder, recommend reset to top)

### Mode Persistence

- Selected mode is stored (current implementation uses state; design doesn't prescribe storage method)
- On page reload, site shows the last selected mode (current behavior, no change)

---

## What's Left to the Builder

1. **Implementation choice:** How to detect desktop vs. mobile for popover vs. bottom sheet
   - Media query? (recommended: `@media (max-width: 768px)`)
   - Or JavaScript-based?
   
2. **Animation easing:** Specific easing function for popover fade-in and bottom sheet slide-up
   - Recommend: ease-out-cubic or similar (natural feel)

3. **Accessibility details:**
   - ARIA labels for mode chip, popover, bottom sheet
   - Keyboard navigation (Tab, Enter/Space to select)
   - Focus management (return focus to chip after selection)

4. **Edge cases:**
   - What if user presses Escape while popover/bottom sheet is open? (Close it)
   - What if user clicks outside popover? (Close it)
   - Mobile keyboard blocking bottom sheet? (Let it be; bottom sheet floats above)

5. **Copy/messaging:** Finalize text for bottom sheet title ("メディアを選択" or alternative)

6. **Testing checklist:**
   - Popover appears/closes correctly on desktop
   - Bottom sheet appears/closes correctly on mobile
   - Mode selection updates all three: chip text, content grid, page state
   - Animations are smooth (no jank)
   - Touch/click targets are large enough on mobile (min 44px × 44px recommended, we have 16px padding)
   - Page is still responsive when popover/bottom sheet is open

---

## Rationale for Model 3 Over Alternatives

| Model | Approach | Why Not Selected |
|-------|----------|------------------|
| **A** | Dropdown below header | Featured content gets hidden; takes vertical space |
| **B** | Hamburger menu | Mode selector becomes hidden; less discovery for casual users |
| **C** | Header chip only, no visual menu | Other modes not visible at a glance; discovery friction |
| **3** | Header chip + platform-aware menu | **Selected.** Balances discoverability, space, and intentionality |

---

## Scope Boundaries

**In Scope:**
- Redesign header layout: logo + mode chip + avatar
- Add popover (desktop) and bottom sheet (mobile) for mode selection
- Update CSS for new layout
- Update JavaScript for popover/bottom sheet open/close behavior

**Out of Scope:**
- Changes to featured banner design
- Changes to content grid or card styling
- New filtering or discovery features
- Changes to data model or backend

---

## Success Metrics (for review)

After implementation:
1. Header layout feels intentional (mode chip is visually part of branding)
2. Light user can discover mode switching within 5 seconds of page load
3. Mode selection doesn't hide featured content
4. Mobile bottom sheet provides large tap targets (no frustration)
5. Desktop popover is compact and doesn't obscure content
6. Animations feel natural, not janky

