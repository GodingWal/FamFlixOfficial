import { storage } from "../storage";
import { InsertCollaborationSession } from "../db/schema";
import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { logger } from "../utils/logger";

interface CollaborationMessage {
  type: "join" | "leave" | "update" | "cursor_move" | "chat";
  userId: string;
  videoId: string;
  data?: any;
  timestamp: number;
}

interface ActiveConnection {
  ws: WebSocket;
  userId: string;
  videoId: string;
  sessionId: string;
  lastPing: number;
  isAlive: boolean;
}

export class CollaborationService {
  private wss: WebSocketServer | null = null;
  private connections: Map<string, ActiveConnection> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 60000; // 60 seconds

  initializeWebSocket(server: Server) {
    this.wss = new WebSocketServer({ 
      server, 
      path: '/ws/collaboration' 
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      logger.info('New collaboration WebSocket connection');

      ws.on('message', async (data) => {
        try {
          const message: CollaborationMessage = JSON.parse(data.toString());
          // Mark connection as alive on any message
          this.markConnectionAlive(ws);
          await this.handleMessage(ws, message);
        } catch (error) {
          logger.error('WebSocket message error', { error });
          ws.send(JSON.stringify({ error: 'Invalid message format' }));
        }
      });

      ws.on('pong', () => {
        this.markConnectionAlive(ws);
      });

      ws.on('close', () => {
        this.handleDisconnection(ws);
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error', { error });
        this.handleDisconnection(ws);
      });
    });

    // Start heartbeat to detect stale connections
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [connectionId, connection] of Array.from(this.connections.entries())) {
        if (!connection.isAlive || (now - connection.lastPing) > this.CONNECTION_TIMEOUT) {
          logger.warn('Terminating stale WebSocket connection', { connectionId, userId: connection.userId });
          connection.ws.terminate();
          this.connections.delete(connectionId);
          storage.endCollaborationSession(connection.sessionId).catch(err =>
            logger.error('Failed to end stale collaboration session', { error: err, sessionId: connection.sessionId })
          );
          continue;
        }

        connection.isAlive = false;
        if (connection.ws.readyState === WebSocket.OPEN) {
          connection.ws.ping();
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  private markConnectionAlive(ws: WebSocket): void {
    for (const connection of this.connections.values()) {
      if (connection.ws === ws) {
        connection.isAlive = true;
        connection.lastPing = Date.now();
        break;
      }
    }
  }

  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.connections.clear();
    logger.info('CollaborationService shutdown complete');
  }

  private async handleMessage(ws: WebSocket, message: CollaborationMessage) {
    switch (message.type) {
      case 'join':
        await this.handleJoin(ws, message);
        break;
      case 'leave':
        await this.handleLeave(ws, message);
        break;
      case 'update':
        await this.handleUpdate(message);
        break;
      case 'cursor_move':
        this.handleCursorMove(message);
        break;
      case 'chat':
        this.handleChat(message);
        break;
    }
  }

  private async handleJoin(ws: WebSocket, message: CollaborationMessage) {
    try {
      // Create collaboration session
      const session = await storage.createCollaborationSession({
        videoId: message.videoId,
        userId: message.userId,
        sessionData: { joinedAt: new Date() },
        isActive: true,
      });

      // Store connection
      const connectionId = `${message.userId}-${message.videoId}`;
      this.connections.set(connectionId, {
        ws,
        userId: message.userId,
        videoId: message.videoId,
        sessionId: session.id,
        lastPing: Date.now(),
        isAlive: true,
      });

      // Notify other collaborators
      this.broadcastToVideo(message.videoId, {
        type: 'user_joined',
        userId: message.userId,
        data: { sessionId: session.id },
        timestamp: Date.now(),
      }, message.userId);

      // Send current collaborators to the new user
      const activeCollaborators = await storage.getActiveCollaborators(message.videoId);
      ws.send(JSON.stringify({
        type: 'collaborators_list',
        data: activeCollaborators,
        timestamp: Date.now(),
      }));

      // Log activity
      await storage.logActivity({
        userId: message.userId,
        action: "join_collaboration",
        resourceType: "video",
        resourceId: message.videoId,
        details: { sessionId: session.id },
      });

    } catch (error) {
      logger.error('Join collaboration error', { error, userId: message.userId, videoId: message.videoId });
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to join collaboration'
      }));
    }
  }

  private async handleLeave(ws: WebSocket, message: CollaborationMessage) {
    const connectionId = `${message.userId}-${message.videoId}`;
    const connection = this.connections.get(connectionId);
    
    if (connection) {
      await storage.endCollaborationSession(connection.sessionId);
      this.connections.delete(connectionId);

      // Notify other collaborators
      this.broadcastToVideo(message.videoId, {
        type: 'user_left',
        userId: message.userId,
        timestamp: Date.now(),
      }, message.userId);

      // Log activity
      await storage.logActivity({
        userId: message.userId,
        action: "leave_collaboration",
        resourceType: "video",
        resourceId: message.videoId,
        details: { sessionId: connection.sessionId },
      });
    }
  }

  private async handleUpdate(message: CollaborationMessage) {
    // Update collaboration session with new data
    const connectionId = `${message.userId}-${message.videoId}`;
    const connection = this.connections.get(connectionId);
    
    if (connection) {
      await storage.updateCollaborationSession(connection.sessionId, {
        sessionData: message.data,
      });

      // Broadcast update to other collaborators
      this.broadcastToVideo(message.videoId, {
        type: 'collaboration_update',
        userId: message.userId,
        data: message.data,
        timestamp: Date.now(),
      }, message.userId);
    }
  }

  private handleCursorMove(message: CollaborationMessage) {
    // Broadcast cursor position to other collaborators
    this.broadcastToVideo(message.videoId, {
      type: 'cursor_update',
      userId: message.userId,
      data: message.data,
      timestamp: Date.now(),
    }, message.userId);
  }

  private handleChat(message: CollaborationMessage) {
    // Broadcast chat message to all collaborators
    this.broadcastToVideo(message.videoId, {
      type: 'chat_message',
      userId: message.userId,
      data: message.data,
      timestamp: Date.now(),
    });
  }

  private handleDisconnection(ws: WebSocket) {
    // Find and remove connection
    for (const [connectionId, connection] of Array.from(this.connections.entries())) {
      if (connection.ws === ws) {
        // End collaboration session
        storage.endCollaborationSession(connection.sessionId);
        
        // Notify other collaborators
        this.broadcastToVideo(connection.videoId, {
          type: 'user_disconnected',
          userId: connection.userId,
          timestamp: Date.now(),
        }, connection.userId);

        this.connections.delete(connectionId);
        break;
      }
    }
  }

  private broadcastToVideo(videoId: string, message: any, excludeUserId?: string) {
    for (const connection of Array.from(this.connections.values())) {
      if (connection.videoId === videoId && 
          connection.userId !== excludeUserId &&
          connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(JSON.stringify(message));
      }
    }
  }

  async getActiveCollaborators(videoId: string) {
    return await storage.getActiveCollaborators(videoId);
  }

  async updateCollaborationSession(sessionId: string, data: any) {
    return await storage.updateCollaborationSession(sessionId, {
      sessionData: data,
    });
  }

  async endCollaborationSession(sessionId: string) {
    await storage.endCollaborationSession(sessionId);
  }

  // Get real-time collaboration statistics
  getCollaborationStats(videoId: string) {
    const videoConnections = Array.from(this.connections.values())
      .filter(conn => conn.videoId === videoId);
    
    return {
      activeUsers: videoConnections.length,
      users: videoConnections.map(conn => conn.userId),
    };
  }
}

export const collaborationService = new CollaborationService();
