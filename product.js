
let carrito = [];

function agregarAlCarrito(nombre, precio) {
    carrito.push({ nombre, precio });
    actualizarCarrito();
}

function actualizarCarrito() {
    const lista = document.getElementById('lista-carrito');
    const total = document.getElementById('total');
    lista.innerHTML = '';
    let suma = 0;
    carrito.forEach(item => {
        const li = document.createElement('li');
        li.textContent = `${item.nombre} - $${item.precio}`;
        lista.appendChild(li);
        suma += item.precio;
    });
    total.textContent = suma;
}

function pagar() {
    if (carrito.length === 0) {
        alert('No hay productos en el carrito.');
        return;
    }

    alert('¡Gracias por tu compra! Te contactaremos por WhatsApp o correo para coordinar el pago.');
    carrito = [];
    actualizarCarrito();
}
