#!/bin/sh

cd "$(dirname "$(realpath $0)")"/..
node ./out/server.js --stdio
