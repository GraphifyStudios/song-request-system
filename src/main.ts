/* eslint-disable @typescript-eslint/no-non-null-assertion */
import "dotenv/config";

import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "path";
import { Masterchat, stringify } from "masterchat";

if (require("electron-squirrel-startup")) {
  app.quit();
}

let currentSong: {
  id: string;
  title: string;
} | null = null;
const songIds = JSON.parse(readFileSync("./songs.json", "utf-8"));
const queue = new Map<
  string,
  {
    title: string;
  }
>();
const cooldowns = new Set<string>();
const trustedChannels = ["UC_aEa8K-EOJ3D6gOs7HcyNg"];

function getRandomSong() {
  return songIds[Math.floor(Math.random() * songIds.length)];
}

async function getSongTitle(videoId: string): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`,
  );
  const data = await res.json();
  return data.items[0].snippet.title;
}

function parseSongTitle(title: string) {
  return title
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

const createWindow = async () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    maximizable: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.webContents.openDevTools();

  ipcMain.handle("yt:get-video", async () => {
    return await getNextSong();
  });

  ipcMain.on("show-context-menu", (_event, videoId) => {
    const menu = Menu.buildFromTemplate([
      {
        label: "Remove from queue",
        click: () => {
          queue.delete(videoId);
          mainWindow.webContents.send(
            "queue-updated",
            [...queue.entries()].map(([k, v]) => ({ id: k, title: v.title })),
          );
        },
      },
      {
        label: "Skip to this song",
        click: () => {
          const video = queue.get(videoId);
          const videoObj = { id: videoId, title: video.title };
          updateSong(videoObj);
          mainWindow.webContents.send("song-skipped", videoObj);
          queue.delete(videoId);
          mainWindow.webContents.send(
            "queue-updated",
            [...queue.entries()].map(([k, v]) => ({ id: k, title: v.title })),
          );
        },
      },
      {
        label: "Copy video link",
        click: () => {
          clipboard.writeText(`https://youtube.com/watch?v=${videoId}`);
        },
      },
    ]);
    menu.popup();
  });

  const mc = await Masterchat.init(process.env.YOUTUBE_STREAM_ID!, {
    credentials: process.env.YOUTUBE_BOT_CREDENTIALS!,
  });

  mc.on("chat", async (chat) => {
    const message = {
      content: stringify(chat.message),
      user: {
        id: chat.authorChannelId,
        name: chat.authorName,
        avatar: chat.authorPhoto,
      },
    };
    if (message.content.startsWith("!sr")) {
      if (cooldowns.has(message.user.id))
        return mc.sendMessage(
          `${message.user.name}, you're on cooldown. Request another song after the current song ends.`,
        );

      // TODO: only add to queue if it's part of `songIds`
      const searchQuery = message.content.split(" ").slice(1).join(" ");
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(
          searchQuery,
        )}&maxResults=1&type=video&key=${process.env.YOUTUBE_API_KEY}`,
      );
      const data = await res.json();
      if (!data.items[0])
        return mc.sendMessage(
          `${message.user.name}, I couldn't find a video with that search query.`,
        );

      const video = data.items[0];
      const videoId = video.id.videoId;
      const title = parseSongTitle(video.snippet.title);
      if (queue.has(videoId))
        return mc.sendMessage(
          `${message.user.name}, ${title} is already in the queue.`,
        );
      if (!songIds.includes(videoId)) {
        if (trustedChannels.includes(video.snippet.channelId)) {
          songIds.push(videoId);
          writeFileSync("songs.json", JSON.stringify(songIds));
        } else
          return mc.sendMessage(
            `${message.user.name}, you can only request songs that are from the playlist.`,
          );
      }

      queue.set(videoId, { title });
      mainWindow.webContents.send(
        "queue-updated",
        [...queue.entries()].map(([k, v]) => ({ id: k, title: v.title })),
      );
      if (!chat.isOwner) cooldowns.add(message.user.id);

      mc.sendMessage(
        `${message.user.name}, ${title} has been added to the queue.`,
      );
    } else if (message.content === "!currentsong") {
      mc.sendMessage(`Currently playing: ${currentSong?.title}`);
    } else if (message.content === "!queue") {
      if (!queue.size)
        return mc.sendMessage("There are no songs in the queue.");
      mc.sendMessage(
        `Next 3 songs in the queue: ${[...queue.entries()].map(([, { title }], index) => `${index + 1}. ${title}`).join(", ")}`,
      );
    } else if (message.content === "!skip") {
      console.log(chat);
      if (!chat.isModerator && !chat.isOwner)
        return mc.sendMessage(
          `${message.user.name}, you are not authorized to skip songs.`,
        );
      mc.sendMessage(`${message.user.name}, skipped ${currentSong?.title}.`);
      const nextSong = await getNextSong();
      mainWindow.webContents.send("song-skipped", nextSong);
    }
  });

  mc.listen({ ignoreFirstResponse: true });

  async function getNextSong() {
    let videoId: string;
    let title: string;
    if (queue.size > 0) {
      const [queueEntry] = [...queue.entries()];
      videoId = queueEntry[0];
      title = queueEntry[1].title;
      queue.delete(videoId);
      mainWindow.webContents.send(
        "queue-updated",
        [...queue.entries()].map(([k, v]) => ({ id: k, title: v.title })),
      );
    } else {
      videoId = getRandomSong();
      title = await getSongTitle(videoId);
    }

    updateSong({ id: videoId, title });
    return { id: videoId, title };
  }

  function updateSong(video: { id: string; title: string }) {
    currentSong = video;
    writeFileSync("current-song.txt", parseSongTitle(video.title));
    cooldowns.clear();
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith("http")) {
      shell.openExternal(details.url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
};

app.on("ready", createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
