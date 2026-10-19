package com.cineplayer.pro

import java.io.BufferedReader
import java.net.URL
import org.json.JSONObject

/**
 * Streaming M3U parser for CinePlayer Pro.
 *
 * Reads one line at a time instead of buffering the complete playlist text.
 * Supports extended M3U attributes, relative stream URLs and per-stream HTTP
 * request headers commonly found in VLC-compatible playlists.
 */
internal object M3uPlaylistParser {
    private val attributePattern = Regex("""([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]*))""")

    fun parse(reader: BufferedReader, playlistUrl: String): List<Channel> {
        val result = ArrayList<Channel>()
        var sawHeader = false
        var pendingName: String? = null
        var pendingGroup = "Sem categoria"
        var pendingLogo: String? = null
        var pendingHeaders = linkedMapOf<String, String>()
        var pendingExtinf = false

        reader.useLines { lines ->
            lines.forEach { raw ->
                val line = raw.trim().removePrefix("\uFEFF")
                if (line.isEmpty()) return@forEach

                if (!sawHeader) {
                    if (!line.startsWith("#EXTM3U", ignoreCase = true)) {
                        throw IllegalStateException("A resposta recebida não é uma playlist M3U válida.")
                    }
                    sawHeader = true
                    return@forEach
                }

                when {
                    line.startsWith("#EXTINF", ignoreCase = true) -> {
                        val comma = line.indexOf(',')
                        val attrPart = if (comma >= 0) line.substring(0, comma) else line
                        val attrs = parseAttributes(attrPart)
                        val displayName = if (comma >= 0) line.substring(comma + 1).trim() else ""
                        pendingName = displayName.ifBlank { attrs["tvg-name"].orEmpty() }
                            .ifBlank { "Canal ${result.size + 1}" }
                        pendingGroup = attrs["group-title"]?.ifBlank { null } ?: "Sem categoria"
                        pendingLogo = attrs["tvg-logo"]?.ifBlank { null }
                        pendingHeaders = linkedMapOf()
                        pendingExtinf = true
                    }
                    line.startsWith("#EXTGRP:", ignoreCase = true) && pendingExtinf -> {
                        pendingGroup = line.substringAfter(':').trim().ifBlank { pendingGroup }
                    }
                    line.startsWith("#EXTVLCOPT:", ignoreCase = true) && pendingExtinf -> {
                        val option = line.substringAfter(':')
                        val separator = option.indexOf('=')
                        if (separator > 0) {
                            val key = option.substring(0, separator).trim().lowercase()
                            val value = option.substring(separator + 1).trim()
                            when (key) {
                                "http-user-agent" -> pendingHeaders["User-Agent"] = value
                                "http-referrer", "http-referer" -> pendingHeaders["Referer"] = value
                                "http-origin" -> pendingHeaders["Origin"] = value
                                "http-cookie" -> pendingHeaders["Cookie"] = value
                            }
                        }
                    }
                    line.startsWith("#EXTHTTP:", ignoreCase = true) && pendingExtinf -> {
                        val json = line.substringAfter(':').trim()
                        try {
                            val objectHeaders = JSONObject(json)
                            val keys = objectHeaders.keys()
                            while (keys.hasNext()) {
                                val key = keys.next()
                                val value = objectHeaders.optString(key).trim()
                                if (key.isNotBlank() && value.isNotBlank()) pendingHeaders[key] = value
                            }
                        } catch (_: Exception) {
                            // Ignore malformed optional headers; keep parsing the playlist.
                        }
                    }
                    line.startsWith("#") -> Unit
                    else -> {
                        if (!line.startsWith("http://", true) && !line.startsWith("https://", true)) {
                            pendingExtinf = false
                            pendingName = null
                            pendingHeaders = linkedMapOf()
                            return@forEach
                        }
                        val resolved = try {
                            URL(URL(playlistUrl), line).toExternalForm()
                        } catch (_: Exception) {
                            line
                        }
                        if (pendingExtinf) {
                            result.add(
                                Channel(
                                    name = pendingName ?: "Canal ${result.size + 1}",
                                    url = resolved,
                                    group = pendingGroup,
                                    logo = pendingLogo,
                                    headers = pendingHeaders.toMap()
                                )
                            )
                        }
                        pendingName = null
                        pendingGroup = "Sem categoria"
                        pendingLogo = null
                        pendingHeaders = linkedMapOf()
                        pendingExtinf = false
                    }
                }
            }
        }

        if (!sawHeader) {
            throw IllegalStateException("A playlist está vazia ou não começa com #EXTM3U.")
        }
        if (result.isEmpty()) {
            throw IllegalStateException("A M3U abriu, mas não encontrei canais com links HTTP/HTTPS e metadados EXTINF.")
        }
        return result
    }

    private fun parseAttributes(line: String): Map<String, String> {
        val attrs = linkedMapOf<String, String>()
        attributePattern.findAll(line).forEach { match ->
            val key = match.groupValues[1].lowercase()
            val value = sequenceOf(match.groupValues[2], match.groupValues[3], match.groupValues[4])
                .firstOrNull { it.isNotEmpty() }.orEmpty()
            attrs[key] = value
        }
        return attrs
    }
}
