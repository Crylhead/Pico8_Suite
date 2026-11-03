pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- corpus #148: long strings, escapes, p8scii and comment/directive-like text in strings.
-- self-authored for pico8_suite tests (cc0).
function fbsum()
 local s=0
 for a=0x6000,0x7ffc,4 do
  s^^=$a
  s=s<<>1
 end
 return s
end

function _init()
 la=[[line one
line two]]
 lb=[==[has ]] and -- inside]==]
 esc="tab\tq\"\\\65"
 glyphs="♥🐱⬆️"
 inc="#include not_a_file.lua"
 cmt='--[[ not a comment ]]'
 wide="\^wwide"
 checks={#la,#lb,#esc,#glyphs,#inc,#cmt,#wide,ord(esc,8),ord(glyphs,1)}
end

function _update60() end

function _draw()
 cls(1)
 ?"strings",2,2,7
 for i=1,#checks do
  ?i.."="..checks[i],2,8+i*7,6
 end
 ?glyphs,80,10,8
 ?la,64,30,12
 print(wide,2,96,10)
 fb=fbsum()
 -- one console line for original/optimized runtime comparison (#148)
 if not reported then reported=true printh("corpus strings ".."checks="..checks[1]..","..checks[2]..","..checks[3]..","..checks[4]..","..checks[5]..","..checks[6]..","..checks[7]..","..checks[8]..","..checks[9].." fb="..tostr(fb,true)) end
end
