import { createApp } from 'vue'
import { createPinia } from 'pinia'
import naive from 'naive-ui'
import App from './App.vue'
import router from './router'

import './styles/theme-presets.css'
import './styles/global.css'
import './styles/glass-cards.css'
import './styles/layout.css'
import './styles/card.css'
import './styles/sidebar.css'
import './styles/header.css'
import './styles/footer.css'
import './styles/page-responsive.css'
import './styles/responsive.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(naive)
app.mount('#app')
