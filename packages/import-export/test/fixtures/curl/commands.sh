# Sample cURL commands (fake credentials only)
curl -X POST 'https://api.example.test/items?x=1' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer {{token}}" \
  --data-raw '{"name":"it'\''s"}'

curl https://api.example.test/search -G --data-urlencode 'q=hello world' -d page=2 -k -L --max-time 5

curl -u demo:not-a-real-password -F 'file=@./photo.jpg;type=image/jpeg' -F caption=hi https://api.example.test/upload
