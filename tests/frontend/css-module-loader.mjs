export async function resolve(specifier, context, nextResolve) {
  if (/\.(css|svg)$/.test(specifier)) {
    return {
      url: new URL(specifier, context.parentURL).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) {
    return { format: "module", source: "", shortCircuit: true };
  }
  if (url.endsWith(".svg")) {
    return { format: "module", source: `export default ${JSON.stringify(url)}`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
