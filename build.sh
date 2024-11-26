#!/usr/bin/env bash

ncu -u
npm i
node _version.js
node _readme.js
npm run build
sort-package-json
npm run fix
