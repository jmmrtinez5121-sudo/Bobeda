name: Crear APK
on:
  workflow_dispatch:
  push:
    branches: [main, master]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17
      - name: Instalar dependencias
        run: npm install
      - name: Generar proyecto Android
        run: npx expo prebuild --platform android --no-install
      - name: Compilar APK
        run: |
          cd android
          chmod +x gradlew
          ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
      - name: Guardar APK
        uses: actions/upload-artifact@v4
        with:
          name: boveda-apk
          path: android/app/build/outputs/apk/release/app-release.apk
