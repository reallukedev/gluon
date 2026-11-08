# Stands in for a real app. Arguments: port=N serves a page, mb=N holds memory, work=N keeps it a little busy.
for arg; do eval "$arg"; done
[ "${mb:-0}" -gt 0 ] && dd if=/dev/zero of=/dev/shm/ballast bs=1M count="$mb" 2>/dev/null
if [ "${work:-0}" -gt 0 ]; then
  (while :; do i=0; while [ "$i" -lt "$work" ]; do i=$((i + 1)); done; sleep 1; done) &
fi
if [ -n "$port" ]; then exec httpd -f -p "$port" -h /www; fi
exec sleep 2147483647
