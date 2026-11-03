pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- corpus #148: code tabs, local/global scope, closures, varargs, goto, metatables,
-- cartdata and memory. self-authored for pico8_suite tests (cc0).
cartdata("p8suite_corpus_v1")
g=1
function counter()
 local n=0
 return function() n+=1 return n end
end
-->8
function va(...)
 local t={...}
 return select("#",...),t[2]
end
local function shadow()
 local g=10
 do local g=g+5 g*=2 end
 return g
end
-->8
function fbsum()
 local s=0
 for a=0x6000,0x7ffc,4 do
  s^^=$a
  s=s<<>1
 end
 return s
end

function _init()
 local c=counter() c() c()
 cnt=c()
 nargs,second=va(4,5,6)
 sh=shadow()
 local i=0
 ::top::
 i+=1
 if i<4 then goto top end
 loops=i
 local mt={__index=function(t,k) return k*2 end}
 dbl=setmetatable({},mt)[21]
 dset(0,7) saved=dget(0)
 poke(0x4400,1,2,3) pk=peek(0x4400)+peek(0x4401)+peek(0x4402)
end

function _update60() end

function _draw()
 cls()
 ?"scopes",2,2,7
 ?"cnt "..cnt.." n "..nargs.." 2nd "..second,2,12,6
 ?"shadow "..sh.." g "..g,2,20,6
 ?"loops "..loops.." mt "..dbl,2,28,6
 ?"peek "..pk.." cdata "..saved,2,36,6
 fb=fbsum()
 -- one console line for original/optimized runtime comparison (#148)
 if not reported then reported=true printh("corpus scopes ".."cnt="..cnt.." n="..nargs.." 2nd="..second.." sh="..sh.." g="..g.." loops="..loops.." mt="..dbl.." pk="..pk.." cdata="..saved.." fb="..tostr(fb,true)) end
end
