---
"materials-studio": minor
---

A search box above the control panel.

Type to filter the panel to the controls whose label matches; folders whose title matches keep
their whole contents, so searching "post" hands you that section intact rather than an empty folder
with a matching name. Matching folders are expanded automatically, outside in — a member's own
toggle does nothing while its group is collapsed. Clearing, or pressing Escape, puts the panel back
the way it was, so a search is something you can back out of rather than something that quietly
rearranges the panel.

It matches labels and button text, deliberately not a row's whole text. Matching everything would
surface every slider sitting at 0.5 for a search of "0.5" — and, less obviously, would let a
renamed Tweakpane class degrade to that behaviour silently instead of failing.

The matching lives in `ui/controlSearch`, apart from the panel, because it is the one part that is
a pure function of DOM plus a string and therefore the one part worth testing directly. Its tests
build a REAL Tweakpane rather than a fixture: the whole thing is a set of assumptions about
Tweakpane's class names, and a fixture would encode those assumptions twice and then agree with
itself forever. Checked by mutation that they fail when those assumptions break.

The input lives outside the pane's container on purpose — the panel disposes and rebuilds its
Tweakpane wholesale when the shape list changes, and anything inside would go with it. An active
filter is re-applied after such a rebuild.
