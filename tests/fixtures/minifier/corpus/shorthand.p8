pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- corpus #148: pico-8 shorthand forms. self-authored for pico8_suite tests (cc0).
function fbsum()
 local s=0
 for a=0x6000,0x7ffc,4 do
  s^^=$a
  s=s<<>1
 end
 return s
end

function _init()
 r={}
 a,b=7,3
 if (a>b) r[1]=1
 n=0
 while (n<5) n+=1
 r[2]=n
 x=10 x-=3 x*=2 x/=7 x%=3
 r[3]=x
 y=17\5 y\=1
 r[4]=y
 r[5]=0b1010^^0b0110
 r[6]=0x8000>>>12
 r[7]=1<<>4
 r[8]=~0x0f&0xff
 poke(0x4300,42) r[9]=@0x4300
 poke2(0x4302,1234) r[10]=%0x4302
 poke4(0x4304,5.5) r[11]=$0x4304
 s="ab" s..="cd" r[12]=#s
 if (a!=b) r[13]=1
 u=2 u^=3 r[14]=u
 c=5 c|=2 c&=6 r[15]=c
 sum=0
 for i=1,#r do sum+=(r[i] or 0)*i end
end

function _update60() end

function _draw()
 cls()
 ?"shorthand",2,2,7
 for i=1,#r do
  ?i..":"..tostr(r[i]),2+(i-1)\8*60,10+(i-1)%8*8,6
 end
 ?"sum "..sum,2,80,11
 fb=fbsum()
 -- one console line for original/optimized runtime comparison (#148)
 if not reported then reported=true printh("corpus shorthand ".."sum="..sum.." fb="..tostr(fb,true)) end
end
