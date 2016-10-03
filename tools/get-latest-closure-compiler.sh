#!/bin/bash -ex
curl -O https://dl.google.com/closure-compiler/compiler-latest.zip
unzip compiler-latest.zip
mv closure-compiler*.jar compiler.jar
rm *.zip 
