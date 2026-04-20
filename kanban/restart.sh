#!/bin/bash
kill -9 $(lsof -ti:3007) 2>/dev/null
kill -9 $(lsof -ti:3008) 2>/dev/null
npm run build
npm run dev:full
