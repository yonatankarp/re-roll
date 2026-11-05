#!/bin/sh
# Extracts the SRD 5.2 spell chapter in reading order, one column at a time.
# A plain pdftotext run mixes up the two columns. Only for the openly licensed SRD PDF.
# Usage: tests/tools/extract-srd-spells.sh <SRD_CC_v5.2.pdf> <output.txt>
set -eu

pdf=$1
output=$2
pages=$(pdfinfo "$pdf" | awk '/^Pages:/ {print $2}')
width=$(pdfinfo "$pdf" | awk '/^Page size:/ {print int($3)}')
height=$(pdfinfo "$pdf" | awk '/^Page size:/ {print int($5)}')
half=$((width / 2))
: >"$output"

page=1
while [ "$page" -le "$pages" ]; do
  text=$(pdftotext -f "$page" -l "$page" "$pdf" - 2>/dev/null || true)
  # A spell page has at least one line in the form that opens a spell entry.
  if printf '%s\n' "$text" | grep -qE '^(Level [1-9] [A-Z][a-z]+ \(|[A-Z][a-z]+ Cantrip \()'; then
    pdftotext -f "$page" -l "$page" -x 0 -y 0 -W "$half" -H "$height" "$pdf" - >>"$output"
    pdftotext -f "$page" -l "$page" -x "$half" -y 0 -W "$half" -H "$height" "$pdf" - >>"$output"
  fi
  page=$((page + 1))
done
