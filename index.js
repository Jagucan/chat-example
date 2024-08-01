import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';
import fs from 'fs';
import cors from 'cors'; // Importa el paquete cors

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i
    });
  }

  setupPrimary();
} else {
  (async () => {
    const db = await open({
      filename: 'chat.db',
      driver: sqlite3.Database
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_offset TEXT UNIQUE,
        content TEXT
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS logins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_table TEXT UNIQUE,
        token TEXT,
        user_id TEXT,
        table_id TEXT
      );
    `);

    const app = express();
    const server = createServer(app);
    const io = new Server(server, {
      connectionStateRecovery: {},
      adapter: createAdapter()
    });

    const __dirname = dirname(fileURLToPath(import.meta.url));

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // Configura CORS
    app.use(cors());

    app.get('/', (req, res) => {
      res.sendFile(join(__dirname, 'index.html'));
    });

    // Endpoint for Menu
    app.get('/api/menu/all', async (req, res) => {
      fs.readFile('list_items.json', (error, file) => {
        if (error) {
          console.log("No se puede leer el archivo", error);
          return res.status(500).json({ error: 'No se puede leer el archivo' });
        }
        const menu = JSON.parse(file);
        return res.json(menu);
      });
    });

    // Endpoint for Login
    app.post('/api/login', async (req, res) => {
      const { token_table } = req.body;

      // Validate token_table length and format
      if (typeof token_table !== 'string' || token_table.length !== 16) {
        return res.status(400).json({ error: 'Invalid token_table format' });
      }

      // Check if the token_table is already in the database
      const example = await db.get('SELECT token, user_id, table_id FROM logins WHERE token_table = ?', [token_table]);

      if (example) {
        return res.json(example);
      }

      // Check if there is space for a new login
      const loginCount = await db.get('SELECT COUNT(*) as count FROM logins');
      if (loginCount.count >= 3) {
        return res.status(403).json({ error: 'Limit of successful logins reached' });
      }

      // Define the list of valid token examples
      const tokenExamples = [
        { token_table: '1234567890abcdef', token: 'abcdefgh12345678', user_id: '1', table_id: '1' },
        { token_table: 'fedcba0987654321', token: '87654321hgfedcba', user_id: '2', table_id: '2' },
        { token_table: 'abcdef1234567890', token: '12345678abcdefgh', user_id: '3', table_id: '3' }
      ];

      const exampleData = tokenExamples.find(item => item.token_table === token_table);

      if (exampleData) {
        // Insert the new login into the database
        await db.run('INSERT INTO logins (token_table, token, user_id, table_id) VALUES (?, ?, ?, ?)',
          exampleData.token_table,
          exampleData.token,
          exampleData.user_id,
          exampleData.table_id
        );
        return res.json({
          token: exampleData.token,
          user_id: exampleData.user_id,
          table_id: exampleData.table_id
        });
      } else {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    });

    io.on('connection', async (socket) => {
      socket.on('#6CAbaFWVm%t8bS4', async (msg, clientOffset, callback) => {
        let result;
        try {
          result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', msg, clientOffset);
        } catch (e) {
          if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
            callback();
          } else {
            // nothing to do, just let the client retry
          }
          return;
        }
        io.emit('#6CAbaFWVm%t8bS4', msg, result.lastID);
        callback();
      });

      if (!socket.recovered) {
        try {
          await db.each('SELECT id, content FROM messages WHERE id > ?',
            [socket.handshake.auth.serverOffset || 0],
            (_err, row) => {
              socket.emit('#6CAbaFWVm%t8bS4', row.content, row.id);
            }
          );
        } catch (e) {
          // something went wrong
        }
      }
    });

    const port = process.env.PORT || 3000;

    server.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  })();
}
