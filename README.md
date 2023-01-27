# mipsy vscode extension thingo (LSP + DAP)

WIP.

Features:
 - Language server (currently only provides error reporting, but shouldn't be too difficult to do other stuff). Currently the LSP is somewhat tightly coupled to vscode but it shouldn't be too difficult to make it work with other editors.
 - A decompile button (vscode only)
 - A debugger adapter (should work with any editor). With it, you can:
   - run and single-step through programs
   - set line breakpoints
   - view register values
   - single-step back through time and run back through time
   - show the contents of memory of running programs (alas vscode only, since the DAP API for this isn't expressive enough so I had to use a custom webview panel)
 - A syntax highlighting grammar (not semantic), generated by `generate_syntax.py`, which pulls data from `mipsy/mips.yaml`.
 - Automatically sets vscode tab settings for mips.

![A screenshot of vscode showing various features of the extension, including the debugger and diagonstic reporting](./screenshot-1.png?raw=true)

Language server / decompile button / debugger all work by running mipsy compiled to WASM using `wasm-pack`. See `mipsy_vscode/src/lib.rs`.

TODO:
 - Add hover + completion + go to definition to the language server
 - Make the debugger better handle output
 - Add other watchpoints?
 - Fancier DAP features
 - Make the code not terrible
 - Publish vscode extension

Biggest caveat is that I have no idea how to allow users to specify that a specific file is part of a multi-file program.

To build, roughly:
```
git clone https://github.com/insou22/mipsy.git
npm i
./generate_syntax.py
(cd mipsy_vscode; wasm-pack build --target nodejs --debug)
npm run compile
```
