function publicUser(u) {
  return { id: u.id, name: u.name, handle: u.handle, email: u.email, avatar: u.avatar, theme: u.theme };
}

module.exports = { publicUser };
