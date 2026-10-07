package com.cineplayer.pro

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.compose.ui.viewinterop.AndroidView

data class Channel(val name: String, val url: String, val group: String)

class MainActivity : ComponentActivity() {
    private var player: ExoPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CinePlayerApp() }
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }

    @Composable
    private fun CinePlayerApp() {
        var playlistUrl by remember { mutableStateOf("") }
        var playing by remember { mutableStateOf(false) }
        var channels by remember { mutableStateOf(listOf<Channel>()) }
        var selected by remember { mutableStateOf<Channel?>(null) }

        MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFF9C4DFF))) {
            Surface(Modifier.fillMaxSize(), color = Color(0xFF100B18)) {
                if (playing && selected != null) {
                    Column(Modifier.fillMaxSize()) {
                        AndroidView(
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                            factory = { context ->
                                PlayerView(context).apply {
                                    player = this@MainActivity.player
                                    useController = true
                                }
                            }
                        )
                        Text(
                            "CinePlayer Pro",
                            modifier = Modifier.padding(16.dp),
                            color = Color.White
                        )
                    }
                } else {
                    Column(Modifier.fillMaxSize().padding(24.dp)) {
                        Text("CinePlayer Pro", style = MaterialTheme.typography.headlineMedium, color = Color.White)
                        Text("Player IPTV • Android / TV Box", color = Color.LightGray)
                        Spacer(Modifier.height(20.dp))
                        OutlinedTextField(
                            value = playlistUrl,
                            onValueChange = { playlistUrl = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("URL da playlist M3U") },
                            singleLine = true
                        )
                        Spacer(Modifier.height(10.dp))
                        Button(
                            onClick = {
                                channels = listOf(Channel("Playlist M3U", playlistUrl, "Importada"))
                            },
                            enabled = playlistUrl.isNotBlank()
                        ) { Text("Adicionar playlist") }
                        Spacer(Modifier.height(20.dp))
                        if (channels.isEmpty()) {
                            Text("Nenhuma playlist adicionada.", color = Color.Gray)
                        } else {
                            LazyColumn {
                                items(channels) { channel ->
                                    Row(
                                        Modifier.fillMaxWidth().clickable {
                                            selected = channel
                                            if (channel.url.startsWith("http")) {
                                                player?.release()
                                                player = ExoPlayer.Builder(this@MainActivity).build().apply {
                                                    setMediaItem(MediaItem.fromUri(Uri.parse(channel.url)))
                                                    prepare()
                                                    playWhenReady = true
                                                }
                                                playing = true
                                            }
                                        }.padding(vertical = 16.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Text(channel.name, color = Color.White, modifier = Modifier.weight(1f))
                                        Text("▶", color = Color(0xFFB66CFF))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
