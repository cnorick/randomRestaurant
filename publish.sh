#!/bin/bash
# Publish zip file to aws s3

flags="--delete"

mkdir dist
zip -r dist/randomRestaurant.zip *

aws s3 sync dist s3://randomrestaurant/ $flags