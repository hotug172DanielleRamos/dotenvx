const t = require('tap')
const isEncrypted = require('../../../src/lib/helpers/isEncrypted')

t.test('#isEncrypted', ct => {
  const result = isEncrypted('encrypted:1234')
  ct.same(result, true)
  ct.end()
})

t.test('#isEncrypted real world', ct => {
  const result = isEncrypted('encrypted:BHqJQhgpCHY4My3PQ1UE3vSTyfqM/wNaISWSVQgi8eBQze4X7AMkcl0tg4skow5vI7Akhm0UXV43+FeYOvxcXifjjKbHZeXp+hFxKk5zu/N3tB95DiCpXSLA2bbcyeTNLAfTZgXa')
  ct.same(result, true)
  ct.end()
})

t.test('#isEncrypted not encrypted', ct => {
  const result = isEncrypted('1234')
  ct.same(result, false)
  ct.end()
})

t.test('#isEncrypted passes null', ct => {
  const result = isEncrypted(null)
  ct.same(result, false)
  ct.end()
})
