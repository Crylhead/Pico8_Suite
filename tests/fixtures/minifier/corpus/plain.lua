-- corpus #148: a plain .lua entry (no cartridge) with globals, locals and constant folding.
-- self-authored for pico8_suite tests (cc0).
local width = 8 * 16
speed = 1 / 4
local function clamp(v, lo, hi)
 return mid(lo, v, hi)
end
function step(x)
 return clamp(x + speed, 0, width - 1)
end
