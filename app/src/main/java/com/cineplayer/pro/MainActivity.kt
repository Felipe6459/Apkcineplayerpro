package com.cineplayer.pro

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

data class Channel(val name: String, val url: String, val group: String, val logo: String? = null, val headers: Map<String, String> = emptyMap())

class MainActivity : ComponentActivity() {
    private var player: ExoPlayer? = null
    private var playbackErrorMessage by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CinePlayerApp() }
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }

    private fun loadFavorites(): Set<String> =
        getSharedPreferences("cineplayer_preferences", MODE_PRIVATE)
            .getStringSet("favorite_urls", emptySet())?.toSet() ?: emptySet()

    private fun saveFavorites(values: Set<String>) {
        getSharedPreferences("cineplayer_preferences", MODE_PRIVATE).edit()
            .putStringSet("favorite_urls", values.toSet()).apply()
    }

    private suspend fun downloadPlaylist(address: String): List<Channel> = withContext(Dispatchers.IO) {
        val parsedUrl = try {
            URL(address)
        } catch (_: Exception) {
            throw IllegalStateException("O endereço da playlist não é válido.")
        }
        if (parsedUrl.protocol !in listOf("http", "https")) {
            throw IllegalStateException("Use um endereço HTTP ou HTTPS.")
        }
        val connection = (parsedUrl.openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000
            readTimeout = 45000
            requestMethod = "GET"
            instanceFollowRedirects = true
            useCaches = false
            setRequestProperty("User-Agent", "CinePlayerPro/0.3 Android")
            setRequestProperty("Accept", "application/vnd.apple.mpegurl, audio/x-mpegurl, application/x-mpegURL, text/plain, */*")
            setRequestProperty("Accept-Encoding", "identity")
        }
        try {
            connection.connect()
            if (connection.responseCode !in 200..299) {
                throw IllegalStateException("O servidor respondeu HTTP ${connection.responseCode}.")
            }
            // Parse incrementally, one line at a time. This avoids holding the
            // full playlist text and a second split copy in memory.
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                M3uPlaylistParser.parse(reader, connection.url.toExternalForm())
            }
        } finally {
            connection.disconnect()
        }
    }

    @Composable
    private fun CinePlayerApp() {
        var playlistUrl by remember { mutableStateOf("") }
        var playing by remember { mutableStateOf(false) }
        var loading by remember { mutableStateOf(false) }
        var status by remember { mutableStateOf("Cole o endereço de uma playlist M3U autorizada.") }
        var channels by remember { mutableStateOf(listOf<Channel>()) }
        var selected by remember { mutableStateOf<Channel?>(null) }
        var search by remember { mutableStateOf("") }
        var favorites by remember { mutableStateOf(loadFavorites()) }
        var selectedCategory by remember { mutableStateOf("Todas") }

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
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(selected!!.name, color = Color.White)
                                Text(selected!!.group, color = Color.LightGray, style = MaterialTheme.typography.bodySmall)
                        playbackErrorMessage?.let { Text(it, color = Color(0xFFFF8A80), style = MaterialTheme.typography.bodySmall) }
                            }
                            TextButton(onClick = { playing = false }) { Text("Voltar à lista") }
                        }
                    }
                } else {
                    Column(Modifier.fillMaxSize().padding(20.dp)) {
                        Text("CinePlayer Pro", style = MaterialTheme.typography.headlineMedium, color = Color.White)
                        Text("Player de mídia • Android / TV Box", color = Color.LightGray)
                        Spacer(Modifier.height(16.dp))
                        OutlinedTextField(
                            value = playlistUrl,
                            onValueChange = { playlistUrl = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("URL da playlist M3U") },
                            placeholder = { Text("https://exemplo.com/lista.m3u") },
                            singleLine = true
                        )
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = {
                                val address = playlistUrl.trim()
                                if (!address.startsWith("https://", true) && !address.startsWith("http://", true)) {
                                    status = "Informe um endereço iniciado por http:// ou https://."
                                } else {
                                    loading = true
                                    status = "Carregando playlist..."
                                    lifecycleScope.launch {
                                        try {
                                            val loaded = downloadPlaylist(address)
                                            channels = loaded
                                            status = if (loaded.isEmpty()) {
                                                "A playlist foi aberta, mas nenhum canal HTTP/HTTPS foi encontrado."
                                            } else {
                                                "Playlist carregada: ${loaded.size} canais."
                                            }
                                        } catch (error: Exception) {
                                            status = "Não foi possível carregar: ${error.message ?: "verifique o endereço e a conexão"}"
                                        } finally {
                                            loading = false
                                        }
                                    }
                                }
                            },
                            enabled = playlistUrl.isNotBlank() && !loading,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            if (loading) CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                strokeWidth = 2.dp,
                                color = Color.White
                            ) else Text("Carregar playlist")
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(status, color = Color(0xFFD7B8FF), style = MaterialTheme.typography.bodySmall)
                        if (channels.isNotEmpty()) {
                            Spacer(Modifier.height(12.dp))
                            OutlinedTextField(
                                value = search,
                                onValueChange = { search = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Buscar canal") },
                                singleLine = true
                            )
                            Spacer(Modifier.height(10.dp))
                            val categoryOptions = listOf("Todas", "Favoritos") +
                                channels.map { it.group }.distinct().sorted()
                            LazyRow(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                contentPadding = PaddingValues(vertical = 4.dp)
                            ) {
                                items(categoryOptions.distinct()) { category ->
                                    FilterChip(
                                        selected = selectedCategory == category,
                                        onClick = { selectedCategory = category },
                                        label = { Text(category) }
                                    )
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            val visibleChannels = channels.filter { channel ->
                                (selectedCategory == "Todas" ||
                                    (selectedCategory == "Favoritos" && channel.url in favorites) ||
                                    channel.group == selectedCategory) &&
                                    (channel.name.contains(search, ignoreCase = true) ||
                                        channel.group.contains(search, ignoreCase = true))
                            }
                            LazyColumn(Modifier.weight(1f)) {
                                items(visibleChannels) { channel ->
                                    Row(
                                        Modifier.fillMaxWidth().clickable {
                                            selected = channel
                                            playbackErrorMessage = null
                                            player?.release()
                                            val httpFactory = DefaultHttpDataSource.Factory()
                                                .setUserAgent("CinePlayerPro/0.3 Android")
                                                .setAllowCrossProtocolRedirects(true)
                                                .setDefaultRequestProperties(channel.headers)
                                            player = ExoPlayer.Builder(this@MainActivity)
                                                .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
                                                .build().apply {
                                                addListener(object : Player.Listener {
                                                    override fun onPlayerError(error: PlaybackException) {
                                                        playbackErrorMessage = when (error.errorCode) {
                                                            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> "O servidor recusou o vídeo (HTTP)."
                                                            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
                                                            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "Falha de conexão ou tempo esgotado ao abrir o canal."
                                                            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
                                                            PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED -> "Formato de vídeo/playlist não reconhecido."
                                                            else -> "Erro ao reproduzir: ${error.errorCodeName}"
                                                        }
                                                    }
                                                })
                                                setMediaItem(MediaItem.fromUri(Uri.parse(channel.url)))
                                                prepare()
                                                playWhenReady = true
                                            }
                                            playing = true
                                        }.padding(vertical = 14.dp, horizontal = 4.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(channel.name, color = Color.White)
                                            Text(channel.group, color = Color.LightGray, style = MaterialTheme.typography.bodySmall)
                                        }
                                        Text("▶", color = Color(0xFFB66CFF))
                                        Spacer(Modifier.width(12.dp))
                                        Text(
                                            if (channel.url in favorites) "★" else "☆",
                                            color = Color(0xFFFFD166),
                                            modifier = Modifier.clickable {
                                                favorites = if (channel.url in favorites) {
                                                    favorites - channel.url
                                                } else {
                                                    favorites + channel.url
                                                }
                                                saveFavorites(favorites)
                                            }.padding(horizontal = 8.dp, vertical = 4.dp)
                                        )
                                    }
                                    HorizontalDivider(color = Color(0xFF352440))
                                }
                            }
                        } else {
                            Spacer(Modifier.height(12.dp))
                            Text("Os canais aparecerão aqui depois que a playlist for carregada.", color = Color.Gray)
                        }
                    }
                }
            }
        }
    }
}
