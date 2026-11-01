// Chrome DevTools requests this file automatically on every page load to
// offer "Automatic Workspace Folders". We don't use that feature, so answer
// with an empty 404 instead of letting React Router log "No route matches URL".
export function loader() {
  return new Response(null, { status: 404 });
}
