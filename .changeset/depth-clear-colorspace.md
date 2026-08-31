---
"@materials3d/core": patch
---

Fix backgrounds being blurred by a depth-of-field lens they were meant to sit exactly in focus for.

The depth pass clears its target to the focal distance, so empty space reads as perfectly in focus
and the gather does not drag shape colour across the backdrop. That clear was built by assigning
the colour's channels directly, which lands the value in the working colour space — and a clear
colour is converted out of the working space on its way into the target. This renderer's output
space is sRGB, so the encoded value was what got stored.

The depth pass writes a linear distance and the post pass decodes one, so the background came back
as 67 world units where the clear was asking for 44: outside the focal range, at close to a maximal
circle of confusion. Every background pixel near a shape was gathering that shape's colour — which
is the exact failure the clear exists to prevent, and it had been happening the whole time.

Declaring the value as sRGB makes three convert it into the working space here, so the conversion
on the way out returns the numbers the code asked for.

**This changes how scenes with depth of field look**: backgrounds are sharp now, and shapes no
longer bleed into them. `skewer` is the clearest case in the gallery.

Found by diffing the two engines' depth targets directly — the node engine, whose output space is
already linear, had been storing the right value all along. Its front-depth target and this one now
match exactly.
