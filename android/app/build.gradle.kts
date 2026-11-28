import java.security.MessageDigest
import groovy.json.JsonOutput
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val pkgJson = JsonSlurper().parse(file("../../package.json")) as Map<*, *>
val appVersionName = pkgJson["version"].toString()
val semverParts = appVersionName.split(".").map { it.toInt() }
val buildOffset = (System.getenv("XMRADAR_BUILD_OFFSET") ?: "0").toInt()
val computedVersionCode = semverParts[0] * 10_000_000 + semverParts[1] * 100_000 + semverParts[2] * 1_000 + buildOffset

// Exact pinned Mozilla GeckoView release (matching Firefox 140+ MV3 requirement, API 36 / AGP 8.9 compatible).
val geckoviewVersion = "151.0.20260608154138"
// Release builds ship arm64-v8a. Local x86_64 emulator builds pass -PgeckoAbi=x86_64; no other value changes.
val geckoAbi = (findProperty("geckoAbi") as String?) ?: "arm64-v8a"

val extensionSourceDir = rootProject.file("../output/firefox-mv3")
val extensionAssetsDir = file("src/main/assets/xmradar")

val buildFirefoxExtension by tasks.registering(Exec::class) {
    onlyIf { project.hasProperty("buildExtension") }
    workingDir = rootProject.file("..")
    commandLine("pnpm", "wxt", "build", "-b", "firefox")
}

val syncExtensionAssets by tasks.registering {
    dependsOn(buildFirefoxExtension)
    inputs.dir(extensionSourceDir).optional()
    outputs.dir(extensionAssetsDir)

    doLast {
        val manifest = extensionSourceDir.resolve("manifest.json")
        if (!manifest.isFile) {
            throw GradleException(
                "Missing ${manifest.absolutePath}. Run `pnpm build` in the repo root first (or pass -PbuildExtension)."
            )
        }
        extensionAssetsDir.deleteRecursively()
        extensionAssetsDir.mkdirs()
        extensionSourceDir.copyRecursively(extensionAssetsDir, overwrite = true)

        // Patch ONLY the Android-bundled copy of manifest.json to add GeckoView built-in native
        // messaging permissions so Chrome Web Store and AMO Firefox manifests stay untouched.
        val bundledManifest = extensionAssetsDir.resolve("manifest.json")
        @Suppress("UNCHECKED_CAST")
        val manifestMap = JsonSlurper().parse(bundledManifest) as MutableMap<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val perms = (manifestMap["permissions"] as? MutableList<Any?> ?: mutableListOf())
        for (extra in listOf("geckoViewAddons", "nativeMessaging")) {
            if (!perms.contains(extra)) perms.add(extra)
        }
        manifestMap["permissions"] = perms
        bundledManifest.writeText(JsonOutput.prettyPrint(JsonOutput.toJson(manifestMap)) + "\n", Charsets.UTF_8)

        // Deterministic SHA-256 of the exact copied (and patched) extension bundle for installBuiltIn upgrade detection.
        // Note: no leading dot — Android AAPT excludes dotfiles from assets/.
        val md = MessageDigest.getInstance("SHA-256")
        val files = extensionAssetsDir.walkTopDown()
            .filter { it.isFile && it.name != "ext-sha256.txt" }
            .sortedBy { it.relativeTo(extensionAssetsDir).invariantSeparatorsPath }
            .toList()
        for (f in files) {
            val rel = f.relativeTo(extensionAssetsDir).invariantSeparatorsPath
            md.update(rel.toByteArray(Charsets.UTF_8))
            md.update(0)
            md.update(f.readBytes())
            md.update(0)
        }
        val sha = md.digest().joinToString("") { "%02x".format(it) }
        extensionAssetsDir.resolve("ext-sha256.txt").writeText("$sha\n", Charsets.UTF_8)
        logger.lifecycle("Synced XMRadar Firefox MV3 assets (${files.size} files, sha256=${sha.take(12)})")
    }
}

android {
    namespace = "rip.kyc.xmradar"
    compileSdk = 36

    defaultConfig {
        applicationId = "rip.kyc.xmradar"
        minSdk = 26
        targetSdk = 35
        versionCode = computedVersionCode
        versionName = appVersionName
    }

    dependenciesInfo {
        // Required for clean F-Droid / privacy-respecting APK packaging (omits Google signing block metadata).
        includeInApk = false
        includeInBundle = false
    }

    signingConfigs {
        val ksPath = System.getenv("XMRADAR_KEYSTORE_PATH")
        if (!ksPath.isNullOrBlank() && file(ksPath).isFile) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = System.getenv("XMRADAR_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("XMRADAR_KEY_ALIAS")
                keyPassword = System.getenv("XMRADAR_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        jniLibs {
            // Compress libxul.so inside the APK (~65 MiB instead of ~190 MiB uncompressed).
            useLegacyPackaging = true
        }
        resources {
            excludes += setOf(
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
                "META-INF/*.kotlin_module"
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

tasks.named("preBuild") {
    dependsOn(syncExtensionAssets)
}

dependencies {
    implementation("org.mozilla.geckoview:geckoview-$geckoAbi:$geckoviewVersion")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
