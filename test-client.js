const WebSocket = require("ws");
const ws = new WebSocket("ws://localhost:3000");
ws.on("open", () => {
  console.log("Connected!");
  ws.send(JSON.stringify({ type: "createRoom", name: "TestHost" }));
});
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  console.log("Received:", msg.type, msg.code || "");
  if (msg.type === "roomCreated") {
    console.log("Room created:", msg.code);
    // Join from another client
    const ws2 = new WebSocket("ws://localhost:3000");
    ws2.on("open", () => {
      ws2.send(JSON.stringify({ type: "joinRoom", code: msg.code, name: "TestPlayer" }));
    });
    ws2.on("message", (d) => {
      const m = JSON.parse(d.toString());
      console.log("Player2 received:", m.type);
      if (m.type === "welcome") {
        console.log("Player joined successfully! Slot:", m.slot);
        console.log("Roster:", JSON.stringify(m.roster.map(r => r.name)));
        ws2.close();
        setTimeout(() => { ws.close(); process.exit(0); }, 200);
      }
    });
  }
  if (msg.type === "roster") {
    console.log("Roster updated:", msg.roster.map(r => r.name).join(", "));
  }
});
ws.on("error", (e) => console.error("Error:", e.message));
