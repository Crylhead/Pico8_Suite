@echo off
rem Starts the PICO-8 bridge for the Code Editor's Run button (keep this window open).
rem Add more cart folders with --root, e.g.:  python "%~dp0pico8_bridge.py" --root C:\GitHub_Projects\Demotools
python "%~dp0pico8_bridge.py" %*
pause
