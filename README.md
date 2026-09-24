# ⚡ ClearPath Command Server

ClearPath is the central cloud intelligence backend for the **Roadly** and **Signal-Aid** applications.

### 🌟 Features
- **Real-time Synchronization**: Socket.IO powered instantly syncing road hazards to emergency drivers.
- **Smart Auto-Expiry Engine**: Intelligent TTL rules automatically resolve expired reports (e.g., accidents last 2 hours, potholes last 48 hours).
- **Admin Dashboard**: A sleek, beautifully designed web dashboard with live statistics, live map data, and real-time status toggles.
- **Points & Badges System**: Fully gamified backend logic that rewards citizens for contributing.
- **RESTful API**: Standardized JSON endpoints for rapid data fetching.

### 🛠️ Tech Stack
- **Node.js & Express**: Lightning fast API routing.
- **Socket.IO**: Real-time websocket broadcasts.
- **SQLite3 (Built from source)**: Lightweight, zero-config relational database.
- **HTML5/CSS3**: Pure, framework-less, high-performance dashboard UI.

### 🌐 Cloud Infrastructure (Free Tier Stack)
Roadly's entire backend ecosystem is hosted using a combination of 4 free services to keep it online permanently:
1. **GitHub** - Hosts the source code and the downloadable APK releases.
2. **Render** - Hosts the Node.js/Socket.IO backend server (Web Service).
3. **Neon.tech** - Provides the permanent, serverless PostgreSQL database.
4. **cron-job.org** - Pings the server's /health endpoint every 10 minutes to prevent Render's free tier from sleeping.

### 🚀 Deployment
This server is optimized for **Render (Free Tier)**. 
- Uses .node-version (v18) to ensure maximum compatibility with pre-built SQLite C++ binaries on Render's Linux environment.
- Fully ephemeral-ready, with graceful fallbacks.
