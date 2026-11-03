pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- corpus #148: repeated #include and includes from two folders.
-- PICO-8 0.2.7 does not allow #include inside an included file, so all are listed here.
-- self-authored for pico8_suite tests (cc0).
total=0
#include lib/util.lua
#include more/deep.lua
#include lib/step.lua
#include lib/step.lua

function _update60() end

function _draw()
 cls()
 ?"includes",2,2,7
 ?"total "..total.." twice "..twice(4).." deep "..deep,2,12,6
 if not reported then reported=true printh("corpus includes total="..total.." twice="..twice(4).." deep="..deep) end
end
