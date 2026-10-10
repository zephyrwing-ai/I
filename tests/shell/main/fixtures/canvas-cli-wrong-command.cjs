process.send({ kind: "canvas:apply", operations: [{ action: "delete", id: "another-element" }] });
process.stdin.resume();
